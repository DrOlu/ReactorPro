import type { CompactionPayload, SerializedGenericCompactionMessage } from "./payload";

// We only need to decide "what language the summary should use"; scanning the
// most recent user input is enough, no full statistics required.
const MAX_SCANNED_CHARS = 4_000;
// When CJK characters reach this proportion of letter-like characters, the
// conversation is considered predominantly CJK. In mixed Chinese/English
// technical conversations many identifiers are English, so the threshold should
// not be too high.
const CJK_DOMINANCE_THRESHOLD = 0.25;
// Do not decide on too small a sample; keep the default (English) summary.
const MIN_SCANNED_LETTERS = 8;

type ScriptCounts = {
  han: number;
  kana: number;
  hangul: number;
  latin: number;
};

function tallyScripts(text: string, counts: ScriptCounts) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) {
      counts.han += 1;
    } else if (code >= 0x3040 && code <= 0x30ff) {
      counts.kana += 1;
    } else if (
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x1100 && code <= 0x11ff) ||
      (code >= 0x3130 && code <= 0x318f)
    ) {
      counts.hangul += 1;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      counts.latin += 1;
    }
  }
}

function collectRecentUserTexts(payload: CompactionPayload): string[] {
  const texts: string[] = [];
  let scannedChars = 0;
  const push = (text: string | undefined) => {
    if (!text || scannedChars >= MAX_SCANNED_CHARS) return;
    const slice = text.slice(0, MAX_SCANNED_CHARS - scannedChars);
    scannedChars += slice.length;
    texts.push(slice);
  };

  push(payload.next_user_message);
  const messages = payload.active_segment_messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (scannedChars >= MAX_SCANNED_CHARS) break;
    const message = messages[index];
    if (message.role !== "user") continue;
    push((message as SerializedGenericCompactionMessage).content);
  }
  return texts;
}

/**
 * Infer the summary language from the user messages in the compaction payload.
 * Returns the English language name (e.g. "Chinese") for
 * buildCompactionSystemPrompt to generate a language instruction; returning
 * undefined means keep the default English summary (Western-language
 * conversation or insufficient sample).
 */
export function detectCompactionSummaryLanguage(payload: CompactionPayload): string | undefined {
  const counts: ScriptCounts = { han: 0, kana: 0, hangul: 0, latin: 0 };
  for (const text of collectRecentUserTexts(payload)) {
    tallyScripts(text, counts);
  }

  const cjk = counts.han + counts.kana + counts.hangul;
  const letters = cjk + counts.latin;
  if (letters < MIN_SCANNED_LETTERS || cjk / letters < CJK_DOMINANCE_THRESHOLD) {
    return undefined;
  }
  // Japanese text necessarily contains kana; Chinese has none. Hangul making up
  // more than half is treated as Korean.
  if (counts.kana > 0 && counts.kana * 20 >= cjk) return "Japanese";
  if (counts.hangul * 2 >= cjk) return "Korean";
  return "Chinese";
}
