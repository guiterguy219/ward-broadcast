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
import { builtInValues, getTemplate, render, TemplateError, wardMonthStartUtc } from "./templates";

/** Minutes a preview stays sendable. */
export const PREVIEW_TTL_MINUTES = 15;
/** Recipients per queue message; stays under the Workers free plan's 50 outbound fetches per run. */
export const SEND_CHUNK_SIZE = 40;
/** Send attempts per recipient before the row is marked failed. */
export const MAX_SEND_ATTEMPTS = 3;
/** Rough all-in 10DLC cost per segment (Telnyx base + carrier fee), USD. */
export const EST_COST_PER_SEGMENT_USD = 0.0075;
export const FOOTER = "Reply STOP to opt out.";

/** Cloudflare Queues accepts at most 100 messages per sendBatch call. */
const QUEUE_BATCH_LIMIT = 100;
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
async function recipientsFor(db: D1Database, groups: Group[], now: Date): Promise<Recipient[]> {
  if (groups.length === 0) return [];
  const placeholders = groups.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT m.id AS member_id, m.phone, ms.group_slug,
         NOT EXISTS (
           SELECT 1 FROM outbox o WHERE o.phone = m.phone AND o.status IN ('sent', 'delivered')
             AND o.updated_at >= ?
         ) AS first_this_month
       FROM members m JOIN memberships ms ON ms.member_id = m.id
       WHERE m.status = 'active' AND ms.status = 'active' AND ms.group_slug IN (${placeholders})
       ORDER BY m.id`,
    )
    .bind(wardMonthStartUtc(now).toISOString(), ...groups.map((group) => group.slug))
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

  const recipients = await recipientsFor(db, groups, now);
  const texts = recipients.map((recipient) =>
    composeText(recipient.group.sender_name, body, recipient.firstTextThisMonth),
  );
  const samples = groups.map((group) => {
    const text = composeText(group.sender_name, body, true);
    return { group: group.slug, text, segments: segmentInfo(text).segments };
  });
  const textInfos = texts.map(segmentInfo);
  const infos = [...textInfos, ...samples.map((sample) => segmentInfo(sample.text))];
  const totalSegments = textInfos.reduce((sum, info) => sum + info.segments, 0);
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
  input: { previewId: string; author: string; now?: Date },
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
  const recipients = await recipientsFor(db, groups, input.now ?? new Date());

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
  try {
    for (let start = 0; start < jobs.length; start += QUEUE_BATCH_LIMIT) {
      await queue.sendBatch(jobs.slice(start, start + QUEUE_BATCH_LIMIT));
    }
  } catch (error) {
    // Cancel every row that hasn't gone out. The consumer only sends 'queued' rows,
    // so chunks that did make it into the queue are cancelled too (barring a race).
    await db.batch([
      db
        .prepare(
          `UPDATE outbox SET status = 'failed', error = 'enqueue failed', updated_at = ${NOW}
           WHERE broadcast_id = ? AND status = 'queued'`,
        )
        .bind(broadcast.id),
      db.prepare("UPDATE broadcasts SET status = 'done' WHERE id = ?").bind(broadcast.id),
    ]);
    throw new BroadcastError(
      `Couldn't queue broadcast ${broadcast.id} (${(error as Error).message}). It was cancelled; ` +
        "check its status before making a new preview.",
    );
  }
  return { broadcastId: broadcast.id, recipients: recipients.length, queueMessages: jobs.length };
}

/** Retry network errors, rate limits, and server errors; anything else won't succeed on retry. */
function isTransient(result: Extract<SendResult, { ok: false }>): boolean {
  return result.status === undefined || result.status === 429 || result.status >= 500;
}

/**
 * Queue consumer for one chunk. Each row's result is saved right after its
 * send, so a retry (or a crash mid-chunk) re-sends at most the one row that
 * was in flight, and delivery webhooks can find the Telnyx id immediately.
 * Members who opted out or left every group in this broadcast are skipped.
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
      `SELECT o.id, o.phone, o.text, o.attempts,
         EXISTS (
           SELECT 1 FROM members m
           JOIN memberships ms ON ms.member_id = m.id AND ms.status = 'active'
           JOIN broadcasts b ON b.id = o.broadcast_id
           WHERE m.phone = o.phone AND m.status = 'active'
             AND ms.group_slug IN (SELECT value FROM json_each(b.groups))
         ) AS still_subscribed
       FROM outbox o
       WHERE o.id IN (${placeholders}) AND o.status = 'queued'`,
    )
    .bind(...job.outboxIds)
    .all<{ id: number; phone: string; text: string; attempts: number; still_subscribed: number }>();

  let retry = false;
  for (const row of rows) {
    if (!row.still_subscribed) {
      await db
        .prepare(`UPDATE outbox SET status = 'skipped', error = 'opted out', updated_at = ${NOW} WHERE id = ?`)
        .bind(row.id)
        .run();
      continue;
    }
    const result = await sender.send(row.phone, row.text);
    const attempts = row.attempts + 1;
    if (result.ok) {
      await db
        .prepare(
          `UPDATE outbox SET status = 'sent', telnyx_id = ?, attempts = ?, error = NULL, updated_at = ${NOW} WHERE id = ?`,
        )
        .bind(result.id, attempts, row.id)
        .run();
    } else if (isTransient(result) && attempts < MAX_SEND_ATTEMPTS) {
      retry = true;
      await db
        .prepare(`UPDATE outbox SET attempts = ?, error = ?, updated_at = ${NOW} WHERE id = ?`)
        .bind(attempts, result.error, row.id)
        .run();
    } else {
      await db
        .prepare(`UPDATE outbox SET status = 'failed', attempts = ?, error = ?, updated_at = ${NOW} WHERE id = ?`)
        .bind(attempts, [result.code, result.error].filter(Boolean).join(" "), row.id)
        .run();
    }
  }
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

/** Recent broadcasts with per-status counts, newest first. */
export async function listBroadcasts(db: D1Database, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.created_at, b.author, b.template_slug, b.groups, b.recipient_count, b.segments, b.status, b.body,
         (SELECT json_group_object(status, n) FROM (SELECT status, COUNT(*) AS n FROM outbox WHERE broadcast_id = b.id GROUP BY status)) AS counts
       FROM broadcasts b ORDER BY b.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<Record<string, unknown> & { groups: string; counts: string }>();
  return results.map((row) => ({ ...row, groups: JSON.parse(row.groups), counts: JSON.parse(row.counts) }));
}

/**
 * Segments that left (sent or delivered) since `since`, and an estimated cost.
 * Counts every outbound broadcast text; keyword replies aren't stored and aren't included.
 */
export async function usageSince(db: D1Database, since: Date) {
  const { results } = await db
    .prepare("SELECT text FROM outbox WHERE status IN ('sent', 'delivered') AND updated_at >= ?")
    .bind(since.toISOString())
    .all<{ text: string }>();
  const segments = results.reduce((sum, row) => sum + segmentInfo(row.text).segments, 0);
  return {
    since: since.toISOString(),
    texts: results.length,
    segments,
    estimatedCostUsd: Math.round(segments * EST_COST_PER_SEGMENT_USD * 100) / 100,
  };
}
