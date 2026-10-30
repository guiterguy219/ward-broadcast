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
  memberId: number;
  /** Groups now waiting for the member to reply YES. */
  pendingGroups: string[];
  /** Groups the member was already active in; nothing changes for these. */
  alreadyActive: string[];
};

/**
 * Records a request to join one or more groups. Nothing becomes active until
 * the member replies YES (see confirmPending, added with the SMS handlers).
 *
 * Steps:
 * 1. Reject unknown or inactive groups.
 * 2. Upsert the member: new or stopped numbers become 'pending'; active stays active.
 * 3. Upsert memberships: active ones stay active; everything else becomes 'pending'.
 * 4. Log one consent row per requested group.
 *
 * @throws Error if any group slug is unknown or inactive, or no groups are given
 */
export async function requestSignup(db: D1Database, request: SignupRequest): Promise<SignupResult> {
  const groupSlugs = [...new Set(request.groups)];
  if (groupSlugs.length === 0) throw new Error("At least one group is required.");
  const known = new Set((await listActiveGroups(db)).map((group) => group.slug));
  const unknown = groupSlugs.filter((slug) => !known.has(slug));
  if (unknown.length > 0) throw new Error(`Unknown group: ${unknown.join(", ")}`);

  const member = await db
    .prepare(
      `INSERT INTO members (phone, name, status) VALUES (?1, ?2, 'pending')
       ON CONFLICT (phone) DO UPDATE SET
         name = COALESCE(excluded.name, members.name),
         status = CASE WHEN members.status = 'active' THEN 'active' ELSE 'pending' END,
         updated_at = ${NOW}
       RETURNING id`,
    )
    .bind(request.phone, request.name?.trim() || null)
    .first<{ id: number }>();
  if (!member) throw new Error("Failed to upsert member.");

  const existing = await db
    .prepare("SELECT group_slug, status FROM memberships WHERE member_id = ?")
    .bind(member.id)
    .all<{ group_slug: string; status: string }>();
  const activeBefore = new Set(
    existing.results.filter((row) => row.status === "active").map((row) => row.group_slug),
  );
  const alreadyActive = groupSlugs.filter((slug) => activeBefore.has(slug));
  const pendingGroups = groupSlugs.filter((slug) => !activeBefore.has(slug));

  const action = request.source === "admin" ? "invited" : "join_requested";
  const statements = [
    ...pendingGroups.map((slug) =>
      db
        .prepare(
          `INSERT INTO memberships (member_id, group_slug, status) VALUES (?1, ?2, 'pending')
           ON CONFLICT (member_id, group_slug) DO UPDATE SET status = 'pending', updated_at = ${NOW}`,
        )
        .bind(member.id, slug),
    ),
    ...pendingGroups.map((slug) =>
      db
        .prepare(
          "INSERT INTO consent_log (phone, action, group_slug, source, actor, detail) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(request.phone, action, slug, request.source, request.actor ?? null, request.detail ?? null),
    ),
  ];
  if (statements.length > 0) await db.batch(statements);

  return { memberId: member.id, pendingGroups, alreadyActive };
}
