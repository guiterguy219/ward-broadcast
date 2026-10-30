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
  const { results } = await db
    .prepare("SELECT * FROM groups WHERE active = 1 ORDER BY slug")
    .all<Group>();
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
      .prepare(
        "INSERT INTO consent_log (phone, action, group_slug, source, actor, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(request.phone, action, slug, request.source, request.actor ?? null, detail ?? null),
  );

  await db.batch([memberUpsert, ...membershipUpserts, ...consentRows]);
  return { pendingGroups, alreadyActive, stopped };
}
