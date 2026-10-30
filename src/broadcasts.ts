/**
 * Broadcast pipeline: preview → send → queue fan-out → delivery status.
 *
 * - previewBroadcast renders the exact texts and stores a short-lived preview.
 * - sendBroadcast accepts only a fresh, unused preview, writes one outbox row
 *   per recipient, and enqueues chunks small enough for one Worker run.
 * - processSendJob (queue consumer) sends one chunk, skipping anyone who opted
 *   out since the send started.
 * - applyDeliveryStatus records Telnyx's final delivery result.
 */
import { listActiveGroups, type Group } from "./db";
import { normalizePunctuation, segmentInfo, type Encoding } from "./segments";
import type { SendResult, SmsSender } from "./telnyx";
import { builtInValues, getTemplate, render, TemplateError } from "./templates";

/** Minutes a preview stays sendable. */
export const PREVIEW_TTL_MINUTES = 15;
/** Recipients per queue message; stays under the Workers free plan's 50 outbound fetches per run. */
export const SEND_CHUNK_SIZE = 40;
/** Send attempts per recipient before the row is marked failed. */
export const MAX_SEND_ATTEMPTS = 3;
/** Rough all-in 10DLC cost per segment (Telnyx base + carrier fee), USD. */
export const EST_COST_PER_SEGMENT_USD = 0.0075;
export const FOOTER = "Reply STOP to opt out.";

/** D1 allows 100 bound parameters per statement. */
const ROWS_PER_INSERT = 20;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export type SendJob = { broadcastId: number; outboxIds: number[] };

export class BroadcastError extends Error {}

type Recipient = { memberId: number; phone: string; group: Group; firstTextThisMonth: boolean };

/**
 * Active members of the given groups, one entry per phone. A member in several
 * groups gets the prefix of the first group in `groupSlugs` order.
 */
async function recipientsFor(db: D1Database, groups: Group[]): Promise<Recipient[]> {
  if (groups.length === 0) return [];
  const placeholders = groups.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT m.id AS member_id, m.phone, ms.group_slug,
         NOT EXISTS (
           SELECT 1 FROM outbox o WHERE o.phone = m.phone AND o.status IN ('queued', 'sent', 'delivered')
             AND o.updated_at >= strftime('%Y-%m-01T00:00:00.000Z', 'now')
         ) AS first_this_month
       FROM members m JOIN memberships ms ON ms.member_id = m.id
       WHERE m.status = 'active' AND ms.status = 'active' AND ms.group_slug IN (${placeholders})
       ORDER BY m.id`,
    )
    .bind(...groups.map((group) => group.slug))
    .all<{ member_id: number; phone: string; group_slug: string; first_this_month: number }>();

  const order = groups.map((group) => group.slug);
  const byPhone = new Map<string, Recipient>();
  for (const row of results) {
    const group = groups.find((candidate) => candidate.slug === row.group_slug)!;
    const current = byPhone.get(row.phone);
    if (!current || order.indexOf(group.slug) < order.indexOf(current.group.slug)) {
      byPhone.set(row.phone, {
        memberId: row.member_id,
        phone: row.phone,
        group,
        firstTextThisMonth: row.first_this_month === 1,
      });
    }
  }
  return [...byPhone.values()];
}

/**
 * The exact text one recipient gets: "<sender>: <body>", plus the opt-out
 * footer when it fits without adding a segment, and always on their first
 * text of the month.
 */
export function composeText(senderName: string, body: string, firstTextThisMonth: boolean): string {
  const base = `${senderName}: ${body}`;
  const withFooter = `${base} ${FOOTER}`;
  if (firstTextThisMonth || segmentInfo(withFooter).segments === segmentInfo(base).segments) return withFooter;
  return base;
}

export type PreviewInput = {
  author: string;
  /** Group slugs; defaults to the template's default groups. */
  groups?: string[];
  /** Either a template slug (with values) or a free-text body. */
  templateSlug?: string;
  values?: Record<string, string>;
  body?: string;
  now?: Date;
};

export type Preview = {
  previewId: string;
  expiresAt: string;
  body: string;
  groups: string[];
  recipients: number;
  /** Worst case across recipients. */
  segments: number;
  encoding: Encoding;
  /** Characters that forced UCS-2 (emoji etc.); empty when GSM-7. */
  nonGsmChars: string[];
  estimatedCostUsd: number;
  /** One example per group, exactly as it will be sent (with footer). */
  samples: { group: string; text: string; segments: number }[];
};

/**
 * Renders a broadcast and stores a preview that send_broadcast can use once.
 * @param signupLink public signup URL (no scheme) for the {{signup_link}} built-in
 * @throws BroadcastError or TemplateError with a message meant for the admin
 */
export async function previewBroadcast(db: D1Database, input: PreviewInput, signupLink: string): Promise<Preview> {
  if (Boolean(input.templateSlug) === Boolean(input.body?.trim())) {
    throw new BroadcastError("Give either a template or a message body, not both.");
  }
  const now = input.now ?? new Date();
  let body: string;
  let groupSlugs = input.groups ?? [];
  if (input.templateSlug) {
    const template = await getTemplate(db, input.templateSlug);
    if (!template) throw new BroadcastError(`No template named "${input.templateSlug}".`);
    body = render(template.body, template.variables, input.values ?? {}, builtInValues(now, signupLink));
    if (groupSlugs.length === 0) groupSlugs = template.defaultGroups;
  } else {
    body = input.body!.trim();
  }
  body = normalizePunctuation(body);
  if (!body) throw new TemplateError("The message is empty.");

  const allGroups = await listActiveGroups(db);
  const unknown = groupSlugs.filter((slug) => !allGroups.some((group) => group.slug === slug));
  if (groupSlugs.length === 0) throw new BroadcastError("Choose at least one group.");
  if (unknown.length > 0) throw new BroadcastError(`Unknown or inactive group: ${unknown.join(", ")}`);
  const groups = groupSlugs.map((slug) => allGroups.find((group) => group.slug === slug)!);

  const recipients = await recipientsFor(db, groups);
  const texts = recipients.map((recipient) =>
    composeText(recipient.group.sender_name, body, recipient.firstTextThisMonth),
  );
  const samples = groups.map((group) => {
    const text = composeText(group.sender_name, body, true);
    return { group: group.slug, text, segments: segmentInfo(text).segments };
  });
  const infos = [...texts, ...samples.map((sample) => sample.text)].map(segmentInfo);
  const totalSegments = texts.reduce((sum, text) => sum + segmentInfo(text).segments, 0);
  const ucs = infos.find((info) => info.encoding === "UCS-2");

  const previewId = `pv_${randomId()}`;
  const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MINUTES * 60_000).toISOString();
  const segments = Math.max(...infos.map((info) => info.segments));
  await db
    .prepare(
      `INSERT INTO previews (id, author, body, template_slug, groups, recipient_count, segments, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      previewId,
      input.author,
      body,
      input.templateSlug ?? null,
      JSON.stringify(groupSlugs),
      recipients.length,
      segments,
      expiresAt,
    )
    .run();

  return {
    previewId,
    expiresAt,
    body,
    groups: groupSlugs,
    recipients: recipients.length,
    segments,
    encoding: ucs ? "UCS-2" : "GSM-7",
    nonGsmChars: ucs?.nonGsmChars ?? [],
    estimatedCostUsd: Math.round(totalSegments * EST_COST_PER_SEGMENT_USD * 100) / 100,
    samples,
  };
}

export type SendSummary = { broadcastId: number; recipients: number; queueMessages: number };

/**
 * Sends a previewed broadcast. The preview must belong to `author`, be unused,
 * and not be expired; it is consumed atomically so it can't be sent twice.
 * Recipients are recomputed now, so anyone who opted out since the preview is skipped.
 */
export async function sendBroadcast(
  db: D1Database,
  queue: Queue<SendJob>,
  input: { previewId: string; author: string },
): Promise<SendSummary> {
  const claimed = await db
    .prepare(
      `UPDATE previews SET used_at = ${NOW}
       WHERE id = ? AND author = ? AND used_at IS NULL AND expires_at > ${NOW}`,
    )
    .bind(input.previewId, input.author)
    .run();
  if (claimed.meta.changes === 0) {
    throw new BroadcastError("That preview is expired, already sent, or not yours. Make a new preview.");
  }
  const preview = (await db
    .prepare("SELECT body, template_slug, groups, segments FROM previews WHERE id = ?")
    .bind(input.previewId)
    .first<{ body: string; template_slug: string | null; groups: string; segments: number }>())!;

  const groupSlugs = JSON.parse(preview.groups) as string[];
  const allGroups = await listActiveGroups(db);
  const groups = groupSlugs.map((slug) => allGroups.find((group) => group.slug === slug)).filter(Boolean) as Group[];
  const recipients = await recipientsFor(db, groups);

  const broadcast = (await db
    .prepare(
      `INSERT INTO broadcasts (preview_id, author, body, template_slug, groups, recipient_count, segments, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      input.previewId,
      input.author,
      preview.body,
      preview.template_slug,
      preview.groups,
      recipients.length,
      preview.segments,
      recipients.length === 0 ? "done" : "queued",
    )
    .first<{ id: number }>())!;
  if (recipients.length === 0) return { broadcastId: broadcast.id, recipients: 0, queueMessages: 0 };

  const inserts = [];
  for (let start = 0; start < recipients.length; start += ROWS_PER_INSERT) {
    const rows = recipients.slice(start, start + ROWS_PER_INSERT);
    inserts.push(
      db
        .prepare(
          `INSERT INTO outbox (broadcast_id, member_id, phone, text, status) VALUES ${rows.map(() => "(?, ?, ?, ?, 'queued')").join(", ")}`,
        )
        .bind(
          ...rows.flatMap((row) => [
            broadcast.id,
            row.memberId,
            row.phone,
            composeText(row.group.sender_name, preview.body, row.firstTextThisMonth),
          ]),
        ),
    );
  }
  await db.batch(inserts);

  const { results } = await db
    .prepare("SELECT id FROM outbox WHERE broadcast_id = ? ORDER BY id")
    .bind(broadcast.id)
    .all<{ id: number }>();
  const ids = results.map((row) => row.id);
  const jobs: MessageSendRequest<SendJob>[] = [];
  for (let start = 0; start < ids.length; start += SEND_CHUNK_SIZE) {
    jobs.push({ body: { broadcastId: broadcast.id, outboxIds: ids.slice(start, start + SEND_CHUNK_SIZE) } });
  }
  await queue.sendBatch(jobs);
  return { broadcastId: broadcast.id, recipients: recipients.length, queueMessages: jobs.length };
}

/** True for failures worth retrying: network errors and HTTP errors without a Telnyx error code. */
function isTransient(result: Extract<SendResult, { ok: false }>): boolean {
  return !result.code;
}

/**
 * Queue consumer for one chunk. Rows already sent (by an earlier attempt) are
 * skipped, so a retried message never double-texts anyone.
 * @returns true if some rows hit a transient error and the message should be retried
 */
export async function processSendJob(db: D1Database, sender: SmsSender, job: SendJob): Promise<boolean> {
  if (job.outboxIds.length === 0) return false;
  await db
    .prepare("UPDATE broadcasts SET status = 'sending' WHERE id = ? AND status = 'queued'")
    .bind(job.broadcastId)
    .run();
  const placeholders = job.outboxIds.map(() => "?").join(", ");
  const { results: rows } = await db
    .prepare(
      `SELECT o.id, o.phone, o.text, o.attempts, COALESCE(m.status, 'stopped') AS member_status
       FROM outbox o LEFT JOIN members m ON m.phone = o.phone
       WHERE o.id IN (${placeholders}) AND o.status = 'queued'`,
    )
    .bind(...job.outboxIds)
    .all<{ id: number; phone: string; text: string; attempts: number; member_status: string }>();

  let retry = false;
  const updates = [];
  for (const row of rows) {
    if (row.member_status !== "active") {
      updates.push(
        db
          .prepare(`UPDATE outbox SET status = 'skipped', error = 'opted out', updated_at = ${NOW} WHERE id = ?`)
          .bind(row.id),
      );
      continue;
    }
    const result = await sender.send(row.phone, row.text);
    const attempts = row.attempts + 1;
    if (result.ok) {
      updates.push(
        db
          .prepare(
            `UPDATE outbox SET status = 'sent', telnyx_id = ?, attempts = ?, error = NULL, updated_at = ${NOW} WHERE id = ?`,
          )
          .bind(result.id, attempts, row.id),
      );
    } else if (isTransient(result) && attempts < MAX_SEND_ATTEMPTS) {
      retry = true;
      updates.push(
        db
          .prepare(`UPDATE outbox SET attempts = ?, error = ?, updated_at = ${NOW} WHERE id = ?`)
          .bind(attempts, result.error, row.id),
      );
    } else {
      updates.push(
        db
          .prepare(`UPDATE outbox SET status = 'failed', attempts = ?, error = ?, updated_at = ${NOW} WHERE id = ?`)
          .bind(attempts, [result.code, result.error].filter(Boolean).join(" "), row.id),
      );
    }
  }
  if (updates.length > 0) await db.batch(updates);
  await db
    .prepare(
      `UPDATE broadcasts SET status = 'done'
       WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM outbox WHERE broadcast_id = ?1 AND status = 'queued')`,
    )
    .bind(job.broadcastId)
    .run();
  return retry;
}

/**
 * Records a Telnyx delivery result (message.finalized).
 * @param telnyxStatus e.g. "delivered", "delivery_failed", "sending_failed"
 */
export async function applyDeliveryStatus(
  db: D1Database,
  telnyxId: string,
  telnyxStatus: string,
  error?: string,
): Promise<void> {
  if (telnyxStatus === "delivered") {
    await db
      .prepare(`UPDATE outbox SET status = 'delivered', updated_at = ${NOW} WHERE telnyx_id = ? AND status = 'sent'`)
      .bind(telnyxId)
      .run();
  } else if (telnyxStatus === "delivery_failed" || telnyxStatus === "sending_failed") {
    await db
      .prepare(`UPDATE outbox SET status = 'failed', error = ?, updated_at = ${NOW} WHERE telnyx_id = ?`)
      .bind(error ?? telnyxStatus, telnyxId)
      .run();
  }
}

/** Counts per outbox status for one broadcast. */
export async function broadcastStatus(db: D1Database, broadcastId: number) {
  const broadcast = await db
    .prepare(
      "SELECT id, author, body, template_slug, groups, recipient_count, segments, status, created_at FROM broadcasts WHERE id = ?",
    )
    .bind(broadcastId)
    .first<Record<string, unknown>>();
  if (!broadcast) return null;
  const { results } = await db
    .prepare("SELECT status, COUNT(*) AS n FROM outbox WHERE broadcast_id = ? GROUP BY status")
    .bind(broadcastId)
    .all<{ status: string; n: number }>();
  return { ...broadcast, counts: Object.fromEntries(results.map((row) => [row.status, row.n])) };
}

/** 128-bit random hex id. */
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export { TemplateError };
