/**
 * Data access for D1. Every function takes the D1 binding so it can run
 * against the real database in the Worker and against node:sqlite in tests.
 */

export type Group = {
  slug: string;
  name: string;
  keyword: string;
  sender_name: string;
  reply_text: string;
  active: number;
};

export type MemberStatus = "pending" | "active" | "stopped";

export type Member = {
  id: number;
  phone: string;
  name: string | null;
  status: MemberStatus;
  created_at: string;
  updated_at: string;
};

export type ConsentSource = "web" | "sms" | "admin";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** All groups that accept members, in a stable order. */
export async function listActiveGroups(db: D1Database): Promise<Group[]> {
  const { results } = await db.prepare("SELECT * FROM groups WHERE active = 1 ORDER BY slug").all<Group>();
  return results;
}

/** Looks up a member by E.164 phone, or null. */
export async function findMemberByPhone(db: D1Database, phone: string): Promise<Member | null> {
  return db.prepare("SELECT * FROM members WHERE phone = ?").bind(phone).first<Member>();
}

export class UnknownGroupError extends Error {}

export type SignupRequest = {
  /** E.164 phone, already validated. */
  phone: string;
  name?: string;
  /** Group slugs; unknown or inactive slugs are rejected. */
  groups: string[];
  source: ConsentSource;
  /** Admin identity when source is 'admin'. */
  actor?: string;
  /** Raw inbound text or a form summary, kept in the consent log. */
  detail?: string;
};

export type SignupResult = {
  /** Groups now waiting for the member to reply YES. */
  pendingGroups: string[];
  /** Groups the member is already receiving; nothing changes for these. */
  alreadyActive: string[];
  /**
   * The number texted STOP and the request didn't come from the phone itself.
   * Nothing is texted; the member must text START or JOIN to opt back in.
   */
  stopped: boolean;
};

/**
 * Records a request to join one or more groups. Nothing becomes active until
 * the member replies YES from their phone.
 *
 * Steps:
 * 1. Reject unknown or inactive groups.
 * 2. Read the member's current state to decide what changes.
 * 3. In one batch: upsert the member, upsert memberships, log consent per group.
 *    - A stopped number only leaves 'stopped' when the request comes by SMS from
 *      that phone; web and admin requests are logged but can't re-open it.
 *    - Existing names are never overwritten from the public form.
 *    - Active memberships stay active even if a confirmation lands mid-request.
 *
 * @throws UnknownGroupError if any group slug is unknown or inactive, or none are given
 */
export async function requestSignup(db: D1Database, request: SignupRequest): Promise<SignupResult> {
  const groupSlugs = [...new Set(request.groups)];
  if (groupSlugs.length === 0) throw new UnknownGroupError("At least one group is required.");
  const known = new Set((await listActiveGroups(db)).map((group) => group.slug));
  const unknown = groupSlugs.filter((slug) => !known.has(slug));
  if (unknown.length > 0) throw new UnknownGroupError(`Unknown group: ${unknown.join(", ")}`);

  const existing = await findMemberByPhone(db, request.phone);
  const stopped = existing?.status === "stopped" && request.source !== "sms";
  const activeBefore = new Set<string>();
  if (existing?.status === "active") {
    const { results } = await db
      .prepare("SELECT group_slug FROM memberships WHERE member_id = ? AND status = 'active'")
      .bind(existing.id)
      .all<{ group_slug: string }>();
    for (const row of results) activeBefore.add(row.group_slug);
  }
  const alreadyActive = groupSlugs.filter((slug) => activeBefore.has(slug));
  const pendingGroups = stopped ? [] : groupSlugs.filter((slug) => !activeBefore.has(slug));
  const loggedGroups = stopped ? groupSlugs : pendingGroups;

  // A stopped member keeps 'stopped' unless the request came from their own phone.
  const nextStatus = `CASE
      WHEN members.status = 'active' THEN 'active'
      WHEN members.status = 'stopped' AND ?3 <> 'sms' THEN 'stopped'
      ELSE 'pending' END`;
  const memberUpsert = db
    .prepare(
      `INSERT INTO members (phone, name, status) VALUES (?1, ?2, 'pending')
       ON CONFLICT (phone) DO UPDATE SET
         name = COALESCE(members.name, excluded.name),
         updated_at = CASE WHEN ${nextStatus} <> members.status OR (members.name IS NULL AND excluded.name IS NOT NULL)
                           THEN ${NOW} ELSE members.updated_at END,
         status = ${nextStatus}`,
    )
    .bind(request.phone, request.name?.trim() || null, request.source);

  const membershipUpserts = pendingGroups.map((slug) =>
    db
      .prepare(
        `INSERT INTO memberships (member_id, group_slug, status)
         VALUES ((SELECT id FROM members WHERE phone = ?1), ?2, 'pending')
         ON CONFLICT (member_id, group_slug) DO UPDATE SET
           status = CASE WHEN memberships.status = 'active' THEN 'active' ELSE 'pending' END,
           updated_at = ${NOW}`,
      )
      .bind(request.phone, slug),
  );

  const action = request.source === "admin" ? "invited" : "join_requested";
  const detail = stopped ? `${request.detail ?? ""} [number is stopped; not re-opened]`.trim() : request.detail;
  const consentRows = loggedGroups.map((slug) =>
    db
      .prepare("INSERT INTO consent_log (phone, action, group_slug, source, actor, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(request.phone, action, slug, request.source, request.actor ?? null, detail ?? null),
  );

  await db.batch([memberUpsert, ...membershipUpserts, ...consentRows]);
  return { pendingGroups, alreadyActive, stopped };
}

/** Groups this number is actively receiving (member active and membership active). */
export async function activeGroupsFor(db: D1Database, phone: string): Promise<Group[]> {
  const { results } = await db
    .prepare(
      `SELECT g.* FROM groups g
       JOIN memberships ms ON ms.group_slug = g.slug AND ms.status = 'active'
       JOIN members m ON m.id = ms.member_id AND m.status = 'active'
       WHERE m.phone = ? ORDER BY g.slug`,
    )
    .bind(phone)
    .all<Group>();
  return results;
}

/**
 * Activates every pending membership after the member replies YES.
 * A stopped number is never confirmed; it must text START or JOIN first.
 * @returns the groups that became active (empty if nothing was pending)
 */
export async function confirmPending(db: D1Database, phone: string, detail: string): Promise<Group[]> {
  const member = await findMemberByPhone(db, phone);
  if (!member || member.status === "stopped") return [];
  const { results: pending } = await db
    .prepare(
      `SELECT g.* FROM groups g JOIN memberships ms ON ms.group_slug = g.slug
       WHERE ms.member_id = ? AND ms.status = 'pending' AND g.active = 1 ORDER BY g.slug`,
    )
    .bind(member.id)
    .all<Group>();
  if (pending.length === 0) return [];

  await db.batch([
    db
      .prepare(
        `UPDATE memberships SET status = 'active', updated_at = ${NOW}
         WHERE member_id = ? AND status = 'pending'`,
      )
      .bind(member.id),
    db.prepare(`UPDATE members SET status = 'active', updated_at = ${NOW} WHERE id = ?`).bind(member.id),
    ...pending.map((group) =>
      db
        .prepare(
          "INSERT INTO consent_log (phone, action, group_slug, source, detail) VALUES (?, 'confirmed', ?, 'sms', ?)",
        )
        .bind(phone, group.slug, detail),
    ),
  ]);
  return pending;
}

/**
 * Removes one group for a member (LEAVE EQ). Other groups are untouched.
 * @returns true if the member was in that group (active or pending)
 */
export async function leaveGroup(db: D1Database, phone: string, groupSlug: string, detail: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE memberships SET status = 'left', updated_at = ${NOW}
       WHERE group_slug = ?2 AND status <> 'left'
         AND member_id = (SELECT id FROM members WHERE phone = ?1)`,
    )
    .bind(phone, groupSlug)
    .run();
  if (result.meta.changes === 0) return false;
  await db
    .prepare("INSERT INTO consent_log (phone, action, group_slug, source, detail) VALUES (?, 'left', ?, 'sms', ?)")
    .bind(phone, groupSlug, detail)
    .run();
  return true;
}

/** STOP: stops all texts to this number. Logged even for numbers we don't know. */
export async function stopNumber(db: D1Database, phone: string, detail: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE members SET status = 'stopped', updated_at = ${NOW} WHERE phone = ?`).bind(phone),
    db
      .prepare("INSERT INTO consent_log (phone, action, source, detail) VALUES (?, 'stopped', 'sms', ?)")
      .bind(phone, detail),
  ]);
}

/**
 * START: turns texts back on for a stopped number, restoring its active memberships.
 * @returns the groups the member is receiving again (empty if none or not stopped)
 */
export async function startNumber(db: D1Database, phone: string, detail: string): Promise<Group[]> {
  const member = await findMemberByPhone(db, phone);
  await db
    .prepare("INSERT INTO consent_log (phone, action, source, detail) VALUES (?, 'started', 'sms', ?)")
    .bind(phone, detail)
    .run();
  if (!member || member.status !== "stopped") return member ? activeGroupsFor(db, phone) : [];
  const { results } = await db
    .prepare("SELECT COUNT(*) AS n FROM memberships WHERE member_id = ? AND status = 'active'")
    .bind(member.id)
    .all<{ n: number }>();
  const next = (results[0]?.n ?? 0) > 0 ? "active" : "pending";
  await db.prepare(`UPDATE members SET status = ?, updated_at = ${NOW} WHERE id = ?`).bind(next, member.id).run();
  return activeGroupsFor(db, phone);
}

/**
 * Marks an inbound Telnyx message as handled.
 * @returns false if it was already handled (a webhook retry)
 */
export async function claimInboundEvent(db: D1Database, telnyxId: string): Promise<boolean> {
  const result = await db
    .prepare("INSERT INTO inbound_events (telnyx_id) VALUES (?) ON CONFLICT (telnyx_id) DO NOTHING")
    .bind(telnyxId)
    .run();
  return result.meta.changes > 0;
}

/** Stores a non-keyword reply. */
export async function recordReply(
  db: D1Database,
  reply: { phone: string; text: string; autoReplied: boolean },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO replies (phone, member_id, text, auto_replied)
       VALUES (?1, (SELECT id FROM members WHERE phone = ?1), ?2, ?3)`,
    )
    .bind(reply.phone, reply.text, reply.autoReplied ? 1 : 0)
    .run();
}

/** True if this number got a canned reply within the last `hours` (loop guard). */
export async function autoRepliedWithin(db: D1Database, phone: string, hours: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM replies WHERE phone = ? AND auto_replied = 1
       AND received_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) LIMIT 1`,
    )
    .bind(phone, `-${hours} hours`)
    .first<{ hit: number }>();
  return row !== null;
}

/**
 * Groups of the most recent broadcast that reached this number within `days`,
 * limited to groups the number still belongs to. Used to pick which group's
 * canned reply to send.
 */
export async function recentBroadcastGroups(db: D1Database, phone: string, days: number): Promise<Group[]> {
  const row = await db
    .prepare(
      `SELECT b.groups FROM outbox o JOIN broadcasts b ON b.id = o.broadcast_id
       WHERE o.phone = ? AND o.status IN ('sent', 'delivered')
         AND b.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
       ORDER BY b.created_at DESC, b.id DESC LIMIT 1`,
    )
    .bind(phone, `-${days} days`)
    .first<{ groups: string }>();
  if (!row) return [];
  const slugs = new Set(JSON.parse(row.groups) as string[]);
  return (await activeGroupsFor(db, phone)).filter((group) => slugs.has(group.slug));
}
