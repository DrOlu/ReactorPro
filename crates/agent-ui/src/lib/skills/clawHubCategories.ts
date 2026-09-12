import type { ClawHubSkillCard } from "./clawHub";

// Sections matching the ClawHub website's sidebar (https://clawhub.ai/skills).
// ClawHub's public API (/api/v1/skills, /api/v1/search) returns no category
// information and does not support filtering by category -- categories exist only
// in its internal backend. So skills are heuristically classified locally by
// keyword: matching multiple categories is normal (the website is the same), and
// matching none falls into other.
export type ClawHubCategorySlug =
  | "integrations"
  | "automation"
  | "research"
  | "development"
  | "productivity"
  | "communication"
  | "creative"
  | "knowledge"
  | "agents"
  | "operations"
  | "security"
  | "finance"
  | "lifestyle"
  | "other";

export const CLAWHUB_CATEGORY_SLUGS: readonly ClawHubCategorySlug[] = [
  "integrations",
  "automation",
  "research",
  "development",
  "productivity",
  "communication",
  "creative",
  "knowledge",
  "agents",
  "operations",
  "security",
  "finance",
  "lifestyle",
  "other",
];

/** Max number of categories labeled per card, to keep the badge row from getting too long. */
const MAX_CATEGORIES_PER_SKILL = 3;

// Keywords are all lowercase; phrases containing spaces match as substrings, and
// single words match on word boundaries. topics hits weigh more than
// name/summary (topics are labeled by the publisher, the strongest signal).
const CATEGORY_KEYWORDS: Record<Exclude<ClawHubCategorySlug, "other">, string[]> = {
  integrations: [
    "api",
    "integration",
    "mcp",
    "webhook",
    "oauth",
    "notion",
    "github",
    "gitlab",
    "jira",
    "linear",
    "airtable",
    "supabase",
    "google workspace",
    "google drive",
    "spotify",
    "sonos",
    "home assistant",
    "zapier",
    "sdk",
    "connector",
    "plugin",
  ],
  automation: [
    "cron",
    "schedule",
    "scheduled",
    "automation",
    "automate",
    "automatic",
    "automatically",
    "workflow",
    "trigger",
    "recurring",
    "daily",
    "batch",
  ],
  research: [
    "search",
    "research",
    "web search",
    "arxiv",
    "paper",
    "papers",
    "literature",
    "scholar",
    "pubmed",
    "wikipedia",
    "news",
    "crawl",
    "scrape",
    "browse",
    "fetch",
  ],
  development: [
    "code",
    "coding",
    "developer",
    "programming",
    "debug",
    "refactor",
    "lint",
    "test",
    "testing",
    "git",
    "pull request",
    "npm",
    "python",
    "typescript",
    "rust",
    "compiler",
    "ide",
    "skill creator",
    "skills",
  ],
  productivity: [
    "todo",
    "task",
    "tasks",
    "note",
    "notes",
    "calendar",
    "reminder",
    "obsidian",
    "markdown",
    "pdf",
    "document",
    "docs",
    "sheet",
    "sheets",
    "spreadsheet",
    "excel",
    "gtd",
    "productivity",
    "plan",
    "planner",
  ],
  communication: [
    "email",
    "gmail",
    "mail",
    "inbox",
    "slack",
    "discord",
    "telegram",
    "whatsapp",
    "wechat",
    "sms",
    "phone",
    "call",
    "calls",
    "voice",
    "message",
    "messaging",
    "chat",
    "twitter",
    "social",
  ],
  creative: [
    "image",
    "images",
    "photo",
    "draw",
    "drawing",
    "design",
    "art",
    "music",
    "audio",
    "video",
    "writing",
    "write",
    "story",
    "creative",
    "svg",
    "diagram",
    "speech",
    "tts",
    "whisper",
    "midjourney",
    "diffusion",
  ],
  knowledge: [
    "memory",
    "memories",
    "knowledge",
    "learn",
    "learning",
    "wiki",
    "ontology",
    "graph",
    "rag",
    "embedding",
    "recall",
    "second brain",
    "zettelkasten",
  ],
  agents: [
    "agent",
    "agents",
    "subagent",
    "multi-agent",
    "autonomous",
    "self-improving",
    "self-improvement",
    "proactive",
    "persona",
    "assistant",
  ],
  operations: [
    "monitor",
    "monitoring",
    "server",
    "servers",
    "devops",
    "deploy",
    "deployment",
    "docker",
    "kubernetes",
    "ssh",
    "logs",
    "metrics",
    "uptime",
    "infrastructure",
    "backup",
    "sysadmin",
    "ops",
  ],
  security: [
    "security",
    "secure",
    "vulnerability",
    "pentest",
    "audit",
    "privacy",
    "password",
    "passwords",
    "encrypt",
    "encryption",
    "vetting",
    "vet",
    "permission",
    "permissions",
    "secrets",
    "2fa",
    "credential",
  ],
  finance: [
    "finance",
    "financial",
    "stock",
    "stocks",
    "crypto",
    "bitcoin",
    "trading",
    "budget",
    "expense",
    "expenses",
    "invoice",
    "payment",
    "bank",
    "banking",
    "money",
    "portfolio",
    "accounting",
  ],
  lifestyle: [
    "health",
    "fitness",
    "recipe",
    "recipes",
    "cooking",
    "weather",
    "travel",
    "smart home",
    "smart-home",
    "speaker",
    "speakers",
    "hue",
    "sleep",
    "habit",
    "habits",
    "shopping",
    "sport",
    "workout",
    "meditation",
  ],
};

type CompiledKeyword = {
  phrase: string | null;
  word: RegExp | null;
};

function compileKeyword(keyword: string): CompiledKeyword {
  if (keyword.includes(" ") || keyword.includes("-")) {
    return { phrase: keyword, word: null };
  }
  return { phrase: null, word: new RegExp(`\\b${keyword}\\b`, "i") };
}

const COMPILED_KEYWORDS = Object.entries(CATEGORY_KEYWORDS).map(([slug, keywords]) => ({
  slug: slug as Exclude<ClawHubCategorySlug, "other">,
  keywords: keywords.map(compileKeyword),
}));

function matches(compiled: CompiledKeyword, haystack: string): boolean {
  if (compiled.phrase) return haystack.includes(compiled.phrase);
  return compiled.word ? compiled.word.test(haystack) : false;
}

const TOPIC_WEIGHT = 3;
const TEXT_WEIGHT = 1;

/**
 * Heuristically classify a single skill: returns 1-3 categories ordered by match
 * strength, or ["other"] when nothing matches. topics hits weigh more than
 * name/summary hits.
 */
export function classifyClawHubSkill(
  skill: Pick<ClawHubSkillCard, "slug" | "displayName" | "summary" | "topics">,
): ClawHubCategorySlug[] {
  const topicsText = skill.topics.join(" ").toLowerCase();
  const bodyText = `${skill.slug} ${skill.displayName} ${skill.summary}`.toLowerCase();

  const scored: Array<{ slug: ClawHubCategorySlug; score: number }> = [];
  for (const { slug, keywords } of COMPILED_KEYWORDS) {
    let score = 0;
    for (const keyword of keywords) {
      if (topicsText && matches(keyword, topicsText)) score += TOPIC_WEIGHT;
      if (matches(keyword, bodyText)) score += TEXT_WEIGHT;
    }
    if (score > 0) scored.push({ slug, score });
  }

  if (scored.length === 0) return ["other"];
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_CATEGORIES_PER_SKILL).map((item) => item.slug);
}
