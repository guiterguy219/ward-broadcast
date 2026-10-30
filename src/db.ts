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

  // Runs after the member upsert in the same batch, so the member's status here is the new one:
  // an active membership stays active only while the member is active.
  const membershipUpserts = pendingGroups.map((slug) =>
    db
      .prepare(
        `INSERT INTO memberships (member_id, group_slug, status)
         VALUES ((SELECT id FROM members WHERE phone = ?1), ?2, 'pending')
         ON CONFLICT (member_id, group_slug) DO UPDATE SET
           status = CASE WHEN memberships.status = 'active'
                          AND (SELECT status FROM members WHERE phone = ?1) = 'active'
                         THEN 'active' ELSE 'pending' END,
           updated_at = ${NOW}`,
      )
      .bind(request.phone, slug),
  );
  // Re-joining by SMS after STOP is a fresh opt-in for just these groups; START is what restores all.
  const reopening = existing?.status === "stopped" && request.source === "sms";
  if (reopening) {
    const placeholders = groupSlugs.map(() => "?").join(", ");
    membershipUpserts.push(
      db
        .prepare(
          `UPDATE memberships SET status = 'left', updated_at = ${NOW}
           WHERE member_id = ? AND status = 'active' AND group_slug NOT IN (${placeholders})`,
        )
        .bind(existing.id, ...groupSlugs),
    );
  }

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

  const placeholders = pending.map(() => "?").join(", ");
  await db.batch([
    db
      .prepare(
        `UPDATE memberships SET status = 'active', updated_at = ${NOW}
         WHERE member_id = ? AND status = 'pending' AND group_slug IN (${placeholders})`,
      )
      .bind(member.id, ...pending.map((group) => group.slug)),
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

/**
 * STOP: stops all texts to this number. An unknown number gets a 'stopped' row
 * so later web signups, invites, and canned replies all see the opt-out.
 */
export async function stopNumber(db: D1Database, phone: string, detail: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO members (phone, status) VALUES (?, 'stopped')
         ON CONFLICT (phone) DO UPDATE SET status = 'stopped', updated_at = ${NOW}`,
      )
      .bind(phone),
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
  if (!member || member.status !== "stopped") return member ? activeGroupsFor(db, phone) : [];
  const { results } = await db
    .prepare("SELECT COUNT(*) AS n FROM memberships WHERE member_id = ? AND status = 'active'")
    .bind(member.id)
    .all<{ n: number }>();
  const next = (results[0]?.n ?? 0) > 0 ? "active" : "pending";
  await db.batch([
    db.prepare(`UPDATE members SET status = ?, updated_at = ${NOW} WHERE id = ?`).bind(next, member.id),
    db
      .prepare("INSERT INTO consent_log (phone, action, source, detail) VALUES (?, 'started', 'sms', ?)")
      .bind(phone, detail),
  ]);
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

/** Undoes claimInboundEvent so a Telnyx retry is processed after a failure. */
export async function releaseInboundEvent(db: D1Database, telnyxId: string): Promise<void> {
  await db.prepare("DELETE FROM inbound_events WHERE telnyx_id = ?").bind(telnyxId).run();
}

/** Limits on confirmation texts triggered by the public web form. */
export const WEB_CONFIRMATION_LIMITS = {
  /** Minimum minutes between confirmation texts to the same number. */
  perPhoneCooldownMinutes: 10,
  /** Maximum confirmation texts to one number per day. */
  perPhonePerDay: 3,
  /** Maximum confirmation texts across all numbers per hour (SMS-pumping guard). */
  globalPerHour: 30,
};

/**
 * Decides whether a web signup may trigger a confirmation text, and records it if so.
 * Counts are based on the web_confirmations log, not on signups, so retries can't evade them.
 */
export async function allowWebConfirmation(db: D1Database, phone: string): Promise<boolean> {
  const limits = WEB_CONFIRMATION_LIMITS;
  const row = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN phone = ?1 AND sent_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?2) THEN 1 ELSE 0 END) AS recent,
         SUM(CASE WHEN phone = ?1 THEN 1 ELSE 0 END) AS today,
         SUM(CASE WHEN sent_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour') THEN 1 ELSE 0 END) AS hour
       FROM web_confirmations WHERE sent_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')`,
    )
    .bind(phone, `-${limits.perPhoneCooldownMinutes} minutes`)
    .first<{ recent: number | null; today: number | null; hour: number | null }>();
  if (
    (row?.recent ?? 0) > 0 ||
    (row?.today ?? 0) >= limits.perPhonePerDay ||
    (row?.hour ?? 0) >= limits.globalPerHour
  ) {
    return false;
  }
  await db.prepare("INSERT INTO web_confirmations (phone) VALUES (?)").bind(phone).run();
  return true;
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

export type MemberListing = {
  phone: string;
  name: string | null;
  status: MemberStatus;
  groups: { slug: string; status: string }[];
  joined: string;
};

/**
 * Members with their group memberships, for admins.
 * @param groupSlug only members with a non-'left' membership in this group
 */
export async function listMembers(db: D1Database, groupSlug?: string): Promise<MemberListing[]> {
  const { results } = await db
    .prepare(
      `SELECT m.phone, m.name, m.status, m.created_at,
         (SELECT json_group_array(json_object('slug', ms.group_slug, 'status', ms.status))
            FROM memberships ms WHERE ms.member_id = m.id AND ms.status <> 'left') AS groups
       FROM members m
       WHERE ?1 IS NULL OR EXISTS (
         SELECT 1 FROM memberships ms WHERE ms.member_id = m.id AND ms.group_slug = ?1 AND ms.status <> 'left')
       ORDER BY m.name IS NULL, m.name, m.phone`,
    )
    .bind(groupSlug ?? null)
    .all<{ phone: string; name: string | null; status: MemberStatus; created_at: string; groups: string }>();
  return results.map((row) => ({
    phone: row.phone,
    name: row.name,
    status: row.status,
    groups: JSON.parse(row.groups) as { slug: string; status: string }[],
    joined: row.created_at,
  }));
}

/**
 * Admin removal (e.g. a member asked in person). Leaves the given groups, or all
 * of them, and logs it. Does not mark the number stopped; only the member can do that.
 * @returns the group slugs that were actually removed
 */
export async function removeMember(
  db: D1Database,
  input: { phone: string; groups?: string[]; actor: string; reason: string },
): Promise<string[]> {
  const member = await findMemberByPhone(db, input.phone);
  if (!member) return [];
  const { results } = await db
    .prepare("SELECT group_slug FROM memberships WHERE member_id = ? AND status <> 'left'")
    .bind(member.id)
    .all<{ group_slug: string }>();
  const targets = results
    .map((row) => row.group_slug)
    .filter((slug) => !input.groups || input.groups.length === 0 || input.groups.includes(slug));
  if (targets.length === 0) return [];
  await db.batch(
    targets.flatMap((slug) => [
      db
        .prepare(`UPDATE memberships SET status = 'left', updated_at = ${NOW} WHERE member_id = ? AND group_slug = ?`)
        .bind(member.id, slug),
      db
        .prepare(
          "INSERT INTO consent_log (phone, action, group_slug, source, actor, detail) VALUES (?, 'removed', ?, 'admin', ?, ?)",
        )
        .bind(input.phone, slug, input.actor, input.reason),
    ]),
  );
  return targets;
}

/** Most recent non-keyword replies, newest first. */
export async function listReplies(db: D1Database, limit: number) {
  const { results } = await db
    .prepare(
      `SELECT r.received_at, r.phone, m.name, r.text, r.auto_replied
       FROM replies r LEFT JOIN members m ON m.id = r.member_id
       ORDER BY r.received_at DESC, r.id DESC LIMIT ?`,
    )
    .bind(limit)
    .all<{ received_at: string; phone: string; name: string | null; text: string; auto_replied: number }>();
  return results;
}
