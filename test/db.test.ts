import { beforeEach, describe, expect, it } from "vitest";
import { findMemberByPhone, listActiveGroups, requestSignup } from "../src/db";
import { createTestDb } from "./d1";

const PHONE = "+18015550123";

describe("migrations", () => {
  it("seed the EQ and RS groups", async () => {
    const { db } = createTestDb();
    const groups = await listActiveGroups(db);
    expect(groups.map((group) => [group.slug, group.keyword, group.sender_name])).toEqual([
      ["eq", "EQ", "Payson 10th Ward EQ"],
      ["rs", "RS", "Payson 10th Ward RS"],
    ]);
  });
});

describe("requestSignup", () => {
  let db: D1Database;
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  beforeEach(() => ({ db, sqlite } = createTestDb()));

  const consentRows = () =>
    sqlite.prepare("SELECT phone, action, group_slug, source, actor FROM consent_log ORDER BY id").all();
  const membershipRows = (memberId: number) =>
    sqlite
      .prepare("SELECT group_slug, status FROM memberships WHERE member_id = ? ORDER BY group_slug")
      .all(memberId);

  it("creates a pending member, pending memberships, and consent rows", async () => {
    const result = await requestSignup(db, { phone: PHONE, name: "Test Member", groups: ["eq", "rs"], source: "web" });
    expect(result.pendingGroups).toEqual(["eq", "rs"]);
    expect(result.alreadyActive).toEqual([]);

    const member = await findMemberByPhone(db, PHONE);
    expect(member).toMatchObject({ name: "Test Member", status: "pending" });
    expect(membershipRows(result.memberId)).toEqual([
      { group_slug: "eq", status: "pending" },
      { group_slug: "rs", status: "pending" },
    ]);
    expect(consentRows()).toEqual([
      { phone: PHONE, action: "join_requested", group_slug: "eq", source: "web", actor: null },
      { phone: PHONE, action: "join_requested", group_slug: "rs", source: "web", actor: null },
    ]);
  });

  it("keeps active memberships active and only adds the new group as pending", async () => {
    const { memberId } = await requestSignup(db, { phone: PHONE, groups: ["eq"], source: "sms" });
    sqlite.prepare("UPDATE members SET status = 'active' WHERE id = ?").run(memberId);
    sqlite.prepare("UPDATE memberships SET status = 'active' WHERE member_id = ?").run(memberId);

    const result = await requestSignup(db, { phone: PHONE, groups: ["eq", "rs"], source: "sms" });
    expect(result).toMatchObject({ alreadyActive: ["eq"], pendingGroups: ["rs"] });
    expect((await findMemberByPhone(db, PHONE))?.status).toBe("active");
    expect(membershipRows(memberId)).toEqual([
      { group_slug: "eq", status: "active" },
      { group_slug: "rs", status: "pending" },
    ]);
  });

  it("moves a stopped number back to pending, and keeps the existing name when none is given", async () => {
    const { memberId } = await requestSignup(db, { phone: PHONE, name: "Original", groups: ["eq"], source: "web" });
    sqlite.prepare("UPDATE members SET status = 'stopped' WHERE id = ?").run(memberId);

    await requestSignup(db, { phone: PHONE, groups: ["eq"], source: "sms" });
    expect(await findMemberByPhone(db, PHONE)).toMatchObject({ name: "Original", status: "pending" });
  });

  it("logs admin invites with the acting admin", async () => {
    await requestSignup(db, { phone: PHONE, groups: ["eq"], source: "admin", actor: "jared", detail: "asked at church" });
    expect(consentRows()).toEqual([{ phone: PHONE, action: "invited", group_slug: "eq", source: "admin", actor: "jared" }]);
  });

  it("rejects unknown groups without writing anything", async () => {
    await expect(requestSignup(db, { phone: PHONE, groups: ["eq", "nope"], source: "web" })).rejects.toThrow(
      "Unknown group: nope",
    );
    await expect(requestSignup(db, { phone: PHONE, groups: [], source: "web" })).rejects.toThrow();
    expect(await findMemberByPhone(db, PHONE)).toBeNull();
  });
});
