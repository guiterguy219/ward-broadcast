/** Program wording shared by the pages, terms, and (later) the SMS replies. */

export const PROGRAM_NAME = "GibsonJ Broadcast";
export const OPERATOR = "Jared Gibson";
/** Who the service currently sends for; shown under the name. */
export const SERVING = "Payson 10th Ward Elders Quorum and Relief Society";
export const EFFECTIVE_DATE = "October 29, 2026";

/** Groups a member can join; `keyword` is what they text after JOIN. */
export const GROUPS = [
  { slug: "eq", keyword: "EQ", name: "Elders Quorum", sender: "Payson 10th Ward EQ" },
  { slug: "rs", keyword: "RS", name: "Relief Society", sender: "Payson 10th Ward RS" },
] as const;

export type GroupSlug = (typeof GROUPS)[number]["slug"];

/** Disclosure shown next to the consent box and repeated in the terms. */
export const FREQUENCY = "Message frequency varies, about 2 messages a week per group.";
export const RATES = "Message and data rates may apply.";
export const KEYWORDS = "Reply HELP for help or STOP to opt out at any time.";

/** Required by General Handbook 38.8.21.2 for calling-related websites. */
export const DISCLAIMER =
  "GibsonJ Broadcast is a personal project by Jared Gibson. It is not an official website or " +
  "product of The Church of Jesus Christ of Latter-day Saints, and it does not speak for the ward.";

/**
 * Formats an E.164 US number for display.
 * @param e164 e.g. "+18015550123"
 * @returns "(801) 555-0123", or the input unchanged if it isn't a US number
 */
export function formatUsPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return e164;
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}

/**
 * Normalizes user-typed US phone input to E.164.
 * @param input any formatting, e.g. "801-555-0123" or "+1 (801) 555 0123"
 * @returns "+18015550123", or null if it isn't a valid 10-digit US number
 */
export function toE164(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  // NANP: area code and exchange can't start with 0 or 1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;
  return `+1${national}`;
}
