/**
 * Automatic SMS replies. Wording matches docs/telnyx-campaign.md, which is what
 * the 10DLC campaign registers; change both together.
 * Keep everything GSM-7 (no curly quotes or emoji) so one text = one segment.
 */
import type { Group } from "./db";

export type ProgramConfig = {
  programName: string;
  operator: string;
  contactEmail: string;
};

/** "Payson 10th Ward EQ" or "Payson 10th Ward EQ and Payson 10th Ward RS". */
function senders(groups: Group[]): string {
  return groups.map((group) => group.sender_name).join(" and ");
}

/** Asks a new or returning member to confirm with YES. */
export function confirmRequest(program: ProgramConfig, groups: Group[]): string {
  return `${program.programName}: Reply YES to get ${senders(groups)} texts, about 2 a week. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
}

/** Sent after YES; this is the registered opt-in confirmation. */
export function optInConfirmed(program: ProgramConfig, groups: Group[]): string {
  return `${program.programName}: You're signed up for ${senders(groups)} texts, about 2 a week. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
}

export function stopConfirmed(program: ProgramConfig): string {
  return `${program.programName}: You're unsubscribed and won't get more texts. Reply START to rejoin.`;
}

/**
 * Reply to START.
 * @param active groups the member is back in
 * @param allGroups every active group, for the "text JOIN" hint when `active` is empty
 */
export function startConfirmed(program: ProgramConfig, active: Group[], allGroups: Group[]): string {
  if (active.length === 0) return `${program.programName}: Texts are turned back on. ${joinHint(program, allGroups)}`;
  return `${program.programName}: Texts are turned back on for ${senders(active)}. Reply STOP to opt out.`;
}

/** Registered HELP response. `serving` is e.g. "Payson 10th Ward EQ and RS". */
export function helpText(program: ProgramConfig, serving: string): string {
  return `${program.programName} is ${program.operator}'s text service for the ${serving}. Questions: ${program.contactEmail}. Reply STOP to opt out.`;
}

/** "To sign up, text JOIN EQ or JOIN RS." */
export function joinHint(program: ProgramConfig, allGroups: Group[]): string {
  const options = allGroups.map((group) => `JOIN ${group.keyword}`).join(" or ");
  return options ? `To sign up, text ${options}.` : `Questions: ${program.contactEmail}.`;
}

/** Reply to an unknown number or a JOIN with no recognizable group. */
export function notSignedUp(program: ProgramConfig, allGroups: Group[]): string {
  return `${program.programName}: ${joinHint(program, allGroups)} Reply HELP for help.`;
}

export function alreadyMember(program: ProgramConfig, groups: Group[]): string {
  return `${program.programName}: You're already signed up for ${senders(groups)}. Reply STOP to opt out.`;
}

export function leftGroup(program: ProgramConfig, left: Group, remaining: Group[]): string {
  const still = remaining.length > 0 ? ` You'll still get ${senders(remaining)} texts.` : "";
  return `${program.programName}: You've left ${left.sender_name}.${still} Reply STOP to stop everything.`;
}

/** Canned answer to a non-keyword reply, from the group's own reply text. */
export function groupReply(group: Group): string {
  return `${group.sender_name}: ${group.reply_text}`;
}

/** Reply to LEAVE with no recognizable group. */
export function leaveHint(program: ProgramConfig, allGroups: Group[]): string {
  const options = allGroups.map((group) => `LEAVE ${group.keyword}`).join(" or ");
  return `${program.programName}: Text ${options}, or STOP to stop everything.`;
}

export function notInGroup(program: ProgramConfig, group: Group): string {
  return `${program.programName}: You aren't signed up for ${group.sender_name}.`;
}
