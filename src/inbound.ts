/**
 * Handles one inbound text: keywords (STOP, START, HELP, YES, JOIN, LEAVE)
 * and the canned reply for everything else.
 */
import {
  activeGroupsFor,
  autoRepliedWithin,
  confirmPending,
  findMemberByPhone,
  leaveGroup,
  listActiveGroups,
  recentBroadcastGroups,
  recordReply,
  requestSignup,
  startNumber,
  stopNumber,
} from "./db";
import * as messages from "./messages";
import type { SmsSender } from "./telnyx";

export type InboundDeps = {
  db: D1Database;
  sender: SmsSender;
  program: messages.ProgramConfig;
  /** Short "who this serves" phrase for HELP, e.g. "Payson 10th Ward EQ and RS". */
  serving: string;
  /**
   * When false, Telnyx's messaging profile answers STOP/START/HELP itself and
   * the app only records state, so members don't get two replies.
   */
  appRepliesToKeywords: boolean;
};

export type InboundAction = "stop" | "start" | "help" | "yes" | "join" | "leave" | "other";

/** Outcome, for logging and tests; never includes the phone number. */
export type InboundOutcome = { action: InboundAction; replied: boolean };

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT", "REVOKE"]);
const START_WORDS = new Set(["START", "UNSTOP"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);
const YES_WORDS = new Set(["YES", "Y"]);

/** Hours between canned replies to the same number, so auto-responders can't loop. */
export const AUTO_REPLY_COOLDOWN_HOURS = 24;
/** How far back a broadcast counts when choosing which group's reply to send. */
export const REPLY_CONTEXT_DAYS = 14;

/**
 * Classifies a text. Keywords must be the whole message (as carriers do), so
 * "can't stop by Saturday" is a normal reply, not an opt-out.
 * @returns the action and, for JOIN/LEAVE, the words after the keyword
 */
export function parseInbound(text: string): { action: InboundAction; args: string[] } {
  const words = text
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const whole = words.join("");
  if (STOP_WORDS.has(whole)) return { action: "stop", args: [] };
  if (START_WORDS.has(whole)) return { action: "start", args: [] };
  if (HELP_WORDS.has(whole)) return { action: "help", args: [] };
  if (YES_WORDS.has(whole)) return { action: "yes", args: [] };
  if (words[0] === "JOIN") return { action: "join", args: words.slice(1) };
  if (words[0] === "LEAVE") return { action: "leave", args: words.slice(1) };
  return { action: "other", args: [] };
}

/**
 * Applies one inbound text and sends at most one reply.
 * @param from sender's E.164 number
 * @param text message body as received
 */
export async function handleInbound(deps: InboundDeps, from: string, text: string): Promise<InboundOutcome> {
  const { db, program } = deps;
  const { action, args } = parseInbound(text);
  const detail = `sms: ${text.slice(0, 160)}`;
  const reply = async (body: string) => {
    const result = await deps.sender.send(from, body);
    if (!result.ok) console.error("reply failed", action, result.code ?? "", result.error);
    return result.ok;
  };

  switch (action) {
    case "stop": {
      await stopNumber(db, from, detail);
      return { action, replied: deps.appRepliesToKeywords && (await reply(messages.stopConfirmed(program))) };
    }
    case "start": {
      const active = await startNumber(db, from, detail);
      if (!deps.appRepliesToKeywords) return { action, replied: false };
      const allGroups = await listActiveGroups(db);
      return { action, replied: await reply(messages.startConfirmed(program, active, allGroups)) };
    }
    case "help": {
      if (!deps.appRepliesToKeywords) return { action, replied: false };
      return { action, replied: await reply(messages.helpText(program, deps.serving)) };
    }
    case "yes": {
      const confirmed = await confirmPending(db, from, detail);
      if (confirmed.length > 0) return { action, replied: await reply(messages.optInConfirmed(program, confirmed)) };
      return handleOther(deps, from, text, reply);
    }
    case "join":
      return handleJoin(deps, from, args, detail, reply);
    case "leave":
      return handleLeave(deps, from, args, detail, reply);
    case "other":
      return handleOther(deps, from, text, reply);
  }
}

type Reply = (body: string) => Promise<boolean>;

async function handleJoin(
  deps: InboundDeps,
  from: string,
  args: string[],
  detail: string,
  reply: Reply,
): Promise<InboundOutcome> {
  const allGroups = await listActiveGroups(deps.db);
  const requested = allGroups.filter((group) => args.includes(group.keyword.toUpperCase()));
  if (requested.length === 0) {
    return { action: "join", replied: await reply(messages.notSignedUp(deps.program, allGroups)) };
  }
  const result = await requestSignup(deps.db, {
    phone: from,
    groups: requested.map((group) => group.slug),
    source: "sms",
    detail,
  });
  if (result.pendingGroups.length > 0) {
    const pending = allGroups.filter((group) => result.pendingGroups.includes(group.slug));
    return { action: "join", replied: await reply(messages.confirmRequest(deps.program, pending)) };
  }
  const already = allGroups.filter((group) => result.alreadyActive.includes(group.slug));
  return { action: "join", replied: await reply(messages.alreadyMember(deps.program, already)) };
}

async function handleLeave(
  deps: InboundDeps,
  from: string,
  args: string[],
  detail: string,
  reply: Reply,
): Promise<InboundOutcome> {
  const allGroups = await listActiveGroups(deps.db);
  const group = allGroups.find((candidate) => args.includes(candidate.keyword.toUpperCase()));
  const member = await findMemberByPhone(deps.db, from);
  if (!group || member?.status === "stopped") {
    // Can't text a stopped number; for an unknown group, explain the options.
    if (member?.status === "stopped") return { action: "leave", replied: false };
    const options = allGroups.map((candidate) => `LEAVE ${candidate.keyword}`).join(" or ");
    return {
      action: "leave",
      replied: await reply(`${deps.program.programName}: Text ${options}, or STOP to stop everything.`),
    };
  }
  const left = await leaveGroup(deps.db, from, group.slug, detail);
  if (!left) {
    return {
      action: "leave",
      replied: await reply(`${deps.program.programName}: You aren't signed up for ${group.sender_name}.`),
    };
  }
  const remaining = await activeGroupsFor(deps.db, from);
  return { action: "leave", replied: await reply(messages.leftGroup(deps.program, group, remaining)) };
}

/**
 * Any other text: store it, and send the canned reply at most once per
 * cooldown window. The group is the one whose broadcast most recently reached
 * this number; otherwise one line per group the member is in.
 */
async function handleOther(deps: InboundDeps, from: string, text: string, reply: Reply): Promise<InboundOutcome> {
  const { db } = deps;
  const member = await findMemberByPhone(db, from);
  const canReply = member?.status !== "stopped" && !(await autoRepliedWithin(db, from, AUTO_REPLY_COOLDOWN_HOURS));
  if (!canReply) {
    await recordReply(db, { phone: from, text, autoReplied: false });
    return { action: "other", replied: false };
  }

  let body: string;
  const recent = await recentBroadcastGroups(db, from, REPLY_CONTEXT_DAYS);
  if (recent.length > 0) {
    body = messages.groupReply(recent[0]);
  } else {
    const active = await activeGroupsFor(db, from);
    body =
      active.length > 0
        ? active.map(messages.groupReply).join("\n")
        : messages.notSignedUp(deps.program, await listActiveGroups(db));
  }
  // Record first so a failed send still counts toward the cooldown.
  await recordReply(db, { phone: from, text, autoReplied: true });
  return { action: "other", replied: await reply(body) };
}
