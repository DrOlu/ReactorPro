import type {
  SubagentRosterEntry,
  SubagentTemplateEntry,
} from "@liveagent/ui/lib/subagents/protocol";
import type { SubagentIdentity, SubagentRunSummary, SubagentSpec, SubagentTemplate } from "./types";
import { truncateText } from "./utils";

const MAX_LISTED_AGENTS = 12;
const MAX_REMINDER_FIELD_CHARS = 360;

export function titleizeStableId(value: string) {
  const words = value
    .trim()
    .split(/[^a-zA-Z0-9]+/g)
    .filter(Boolean);
  if (words.length === 0) return "";
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ");
}

/**
 * Create the persistent identity for a new stable agent id. Creation fields
 * are honored verbatim; missing fields are derived mechanically from the id
 * or the referenced template — never inferred from prompt text.
 */
export function createSubagentIdentity(params: {
  parentConversationId: string;
  toolCallId: string;
  spec: SubagentSpec;
  template?: SubagentTemplate;
  now: number;
}): SubagentIdentity {
  const name =
    params.spec.name?.trim() ||
    params.template?.name.trim() ||
    titleizeStableId(params.spec.id) ||
    params.spec.id;
  const role = params.spec.role?.trim() || params.template?.description.trim() || name;
  return {
    parentConversationId: params.parentConversationId,
    agentId: params.spec.id,
    name,
    role,
    identityPrompt: params.spec.identity?.trim() ?? "",
    templateId: params.template?.id ?? params.spec.templateId,
    lastMode: params.spec.mode,
    createdToolCallId: params.toolCallId,
    createdAt: params.now,
    updatedAt: params.now,
  };
}

export function buildRosterEntries(
  identities: Iterable<SubagentIdentity>,
  latestRunsByAgent: Map<string, SubagentRunSummary>,
): SubagentRosterEntry[] {
  const entries: SubagentRosterEntry[] = [];
  for (const identity of identities) {
    const latestRun = latestRunsByAgent.get(identity.agentId);
    entries.push({
      id: identity.agentId,
      name: identity.name,
      role: identity.role,
      lastMode: identity.lastMode,
      lastStatus: latestRun?.status,
      lastSummary: latestRun?.summary ? truncateText(latestRun.summary, 500) : undefined,
    });
  }
  return entries;
}

export function buildTemplateEntries(templates: SubagentTemplate[]): SubagentTemplateEntry[] {
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description || undefined,
  }));
}

/** Roster block embedded in the Agent tool description. */
export function formatRoster(entries: SubagentRosterEntry[]) {
  if (entries.length === 0) {
    return "No existing agents are recorded for this parent conversation.";
  }
  return entries
    .slice(0, MAX_LISTED_AGENTS)
    .map((entry) => {
      const status = entry.lastStatus ? ` status=${entry.lastStatus}` : "";
      const summary = entry.lastSummary ? ` summary=${entry.lastSummary}` : "";
      return `id=${entry.id} name=${entry.name} role=${entry.role} mode=${entry.lastMode}${status}${summary}`;
    })
    .join("\n");
}

/** Template block embedded in the Agent tool description. */
export function formatTemplates(entries: SubagentTemplateEntry[]) {
  if (entries.length === 0) return "No enabled AGENTS templates are available.";
  return entries
    .slice(0, MAX_LISTED_AGENTS)
    .map((entry) => {
      const description = entry.description ? ` - ${entry.description}` : "";
      return `${entry.id} (${entry.name})${description}`;
    })
    .join("\n");
}

function truncateReminderField(value: string, maxChars = MAX_REMINDER_FIELD_CHARS) {
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

/**
 * Normalizes the identity list: filters out empty id/name, sorts by agentId, and
 * truncates to the cap. The stable and volatile sections share the same
 * selection result, so both truncate identically — otherwise a misalignment
 * would arise where "the stable section lists an agent but the volatile section
 * does not".
 *
 * Sorting deliberately does **not** use `localeCompare`: it depends on locale
 * and ICU version, so the same input may produce a different order in different
 * environments, effectively manufacturing prefix differences out of thin air
 * (see the Common Mistake section of
 * spec/liveagent/frontend/prompt-cache-stability.md). Normalization itself is
 * also required: `listIdentities()` returns in reverse `updatedAt` order, so
 * updating any identity changes the returned order, while the stable section
 * requires that "if the identity set is unchanged, the bytes are unchanged".
 * The cost is that above the cap, the listed agents are no longer the 12 most
 * recently updated but the 12 earliest by id order.
 */
function selectListedIdentities(identities: SubagentIdentity[]) {
  const usable = identities
    .filter((identity) => identity.agentId.trim() && identity.name.trim())
    .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  return {
    listed: usable.slice(0, MAX_LISTED_AGENTS),
    omittedCount: Math.max(0, usable.length - MAX_LISTED_AGENTS),
  };
}

/**
 * System-prompt reminder for the parent agent listing existing subagents,
 * so follow-up user requests are routed to the stable ids instead of the
 * parent impersonating them.
 *
 * Contains only identity fields (id / name / role): if the identity set is
 * unchanged the bytes are unchanged, so it is safe to keep in the systemPrompt.
 * mode is not part of identity — it changes with every Agent call (lastMode),
 * and putting it here would break the byte stability of the stable section, so
 * like the run state (status / last_task / last_summary) it is rendered
 * separately by buildRosterRunStatusSection and appended to the end of the
 * message.
 */
export function buildRosterIdentitySection(params: { identities: SubagentIdentity[] }) {
  const { listed, omittedCount } = selectListedIdentities(params.identities);
  if (listed.length === 0) return "";

  const agentLines = listed.map((identity) => {
    const fields = [
      `id=${identity.agentId}`,
      `name=${truncateReminderField(identity.name, 120)}`,
      `role=${truncateReminderField(identity.role, 160)}`,
    ];
    return `- ${fields.join(" ")}`;
  });

  if (omittedCount > 0) {
    agentLines.push(`- ... ${omittedCount} more omitted`);
  }

  return [
    "Existing delegated agents in this parent conversation:",
    ...agentLines,
    "",
    "If the latest user message is addressed to these existing agents, experts, or the previous team — or asks them to continue, revise, compare, or discuss a follow-up — call Agent again with an `agents` entry per existing id. Do not impersonate those agents from the parent transcript.",
    "Agent resumes each id's previous private context by default, so put only the new user request and any necessary parent-visible context in each resumed agent's prompt. Do not restate name, role, or identity for an existing id. Set resume=false only when the user asks to replace, rebuild, or start fresh.",
    "For simple parent-level summaries of already returned reports, you may answer directly without calling Agent.",
  ].join("\n");
}

/**
 * The volatile section of the roster: contains only fields that change as
 * subagent runs progress.
 *
 * It shares selectListedIdentities' selection result with the stable section, so
 * the listed ids are always a subset of the stable section's; identities with no
 * historical run do not appear (the same convention as before the split, where
 * "no latestRun means those fields are omitted").
 *
 * Pure function: no time values and no randomness, so identical input yields
 * identical output — callers use "is the output the same as last time" to decide
 * whether to deliver it.
 */
export function buildRosterRunStatusSection(params: {
  identities: SubagentIdentity[];
  latestRunsByAgent: Map<string, SubagentRunSummary>;
}) {
  const { listed } = selectListedIdentities(params.identities);

  const agentLines: string[] = [];
  for (const identity of listed) {
    const latestRun = params.latestRunsByAgent.get(identity.agentId);
    if (!latestRun) continue;
    const fields = [
      `id=${identity.agentId}`,
      `status=${latestRun.status}`,
      // mode changes with every Agent call and was moved here from the identity section; it is still a deterministic field, so it does not break the pure-function contract.
      `mode=${identity.lastMode}`,
      `last_task=${truncateReminderField(latestRun.prompt)}`,
    ];
    if (latestRun.summary) {
      fields.push(`last_summary=${truncateReminderField(latestRun.summary)}`);
    }
    agentLines.push(`- ${fields.join(" ")}`);
  }
  if (agentLines.length === 0) return "";

  return [
    "Latest run state of the delegated agents listed in the system prompt:",
    ...agentLines,
  ].join("\n");
}
