/**
 * SMS segment math. A GSM-7 message fits 160 characters in one segment (153
 * per segment when split); any character outside GSM-7 (emoji, curly quotes)
 * switches the whole message to UCS-2 at 70 (67 when split).
 */

const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
/** Extension-table characters cost two septets each. */
const GSM_EXTENDED = "^{}\\[~]|€\f";

const BASIC = new Set(GSM_BASIC);
const EXTENDED = new Set(GSM_EXTENDED);

export type Encoding = "GSM-7" | "UCS-2";

export type SegmentInfo = {
  encoding: Encoding;
  /** Characters that forced UCS-2, de-duplicated, in order of appearance. */
  nonGsmChars: string[];
  /** Length in the units the encoding counts (septets or UTF-16 code units). */
  units: number;
  segments: number;
};

/** Common look-alikes that silently force UCS-2, with GSM-7 replacements. */
export const SMART_PUNCTUATION: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  " ": " ",
};

/** Replaces curly quotes, dashes, ellipses, and non-breaking spaces with GSM-7 equivalents. */
export function normalizePunctuation(text: string): string {
  return [...text].map((char) => SMART_PUNCTUATION[char] ?? char).join("");
}

/**
 * Counts segments for one message.
 * @param text the exact text that will be sent
 */
export function segmentInfo(text: string): SegmentInfo {
  const nonGsm: string[] = [];
  let septets = 0;
  for (const char of text) {
    if (BASIC.has(char)) septets += 1;
    else if (EXTENDED.has(char)) septets += 2;
    else if (!nonGsm.includes(char)) nonGsm.push(char);
  }
  if (nonGsm.length === 0) {
    return {
      encoding: "GSM-7",
      nonGsmChars: [],
      units: septets,
      segments: septets <= 160 ? 1 : Math.ceil(septets / 153),
    };
  }
  const units = text.length; // UTF-16 code units; emoji count as 2
  return { encoding: "UCS-2", nonGsmChars: nonGsm, units, segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}
