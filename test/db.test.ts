import { beforeEach, describe, expect, it } from "vitest";
import { findMemberByPhone, listActiveGroups, requestSignup, UnknownGroupError } from "../src/db";
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
  const membershipRows = () =>
    sqlite
      .prepare(
        "SELECT group_slug, ms.status FROM memberships ms JOIN members m ON m.id = ms.member_id WHERE m.phone = ? ORDER BY group_slug",
      )
      .all(PHONE);
  const setStatus = (status: string, membershipStatus?: string) => {
    sqlite.prepare("UPDATE members SET status = ? WHERE phone = ?").run(status, PHONE);
    if (membershipStatus) sqlite.prepare("UPDATE memberships SET status = ?").run(membershipStatus);
  };

  it("creates a pending member, pending memberships, and consent rows", async () => {
    const result = await requestSignup(db, { phone: PHONE, name: "Test Member", groups: ["eq", "rs"], source: "web" });
    expect(result).toEqual({ pendingGroups: ["eq", "rs"], alreadyActive: [], stopped: false });
    expect(await findMemberByPhone(db, PHONE)).toMatchObject({ name: "Test Member", status: "pending" });
    expect(membershipRows()).toEqual([
      { group_slug: "eq", status: "pending" },
      { group_slug: "rs", status: "pending" },
    ]);
    expect(consentRows()).toEqual([
      { phone: PHONE, action: "join_requested", group_slug: "eq", source: "web", actor: null },
      { phone: PHONE, action: "join_requested", group_slug: "rs", source: "web", actor: null },
    ]);
  });

  it("keeps active memberships active and only adds the new group as pending", async () => {
    await requestSignup(db, { phone: PHONE, groups: ["eq"], source: "sms" });
    setStatus("active", "active");

    const result = await requestSignup(db, { phone: PHONE, groups: ["eq", "rs"], source: "sms" });
    expect(result).toEqual({ alreadyActive: ["eq"], pendingGroups: ["rs"], stopped: false });
    expect((await findMemberByPhone(db, PHONE))?.status).toBe("active");
    expect(membershipRows()).toEqual([
      { group_slug: "eq", status: "active" },
      { group_slug: "rs", status: "pending" },
    ]);
  });

  it("writes nothing and keeps updated_at when an active member re-requests the same group", async () => {
    await requestSignup(db, { phone: PHONE, groups: ["eq"], source: "web" });
    setStatus("active", "active");
    sqlite.prepare("UPDATE members SET updated_at = '2000-01-01T00:00:00.000Z'").run();
    const before = consentRows().length;

    const result = await requestSignup(db, { phone: PHONE, groups: ["eq"], source: "web" });
    expect(result).toEqual({ alreadyActive: ["eq"], pendingGroups: [], stopped: false });
    expect(consentRows()).toHaveLength(before);
    expect((await findMemberByPhone(db, PHONE))?.updated_at).toBe("2000-01-01T00:00:00.000Z");
  });

  it("does not re-open a stopped number from the web form, but logs the request", async () => {
    await requestSignup(db, { phone: PHONE, groups: ["eq"], source: "web" });
    setStatus("stopped", "active");

    const result = await requestSignup(db, { phone: PHONE, groups: ["eq"], source: "web" });
    expect(result).toEqual({ pendingGroups: [], alreadyActive: [], stopped: true });
    expect((await findMemberByPhone(db, PHONE))?.status).toBe("stopped");
    expect(consentRows().at(-1)).toMatchObject({ action: "join_requested", group_slug: "eq", source: "web" });
  });

  it("re-opens a stopped number when the request comes by SMS from that phone", async () => {
    await requestSignup(db, { phone: PHONE, groups: ["eq"], source: "web" });
    setStatus("stopped", "active");

    const result = await requestSignup(db, { phone: PHONE, groups: ["eq"], source: "sms" });
    expect(result).toEqual({ pendingGroups: ["eq"], alreadyActive: [], stopped: false });
    expect((await findMemberByPhone(db, PHONE))?.status).toBe("pending");
    expect(membershipRows()).toEqual([{ group_slug: "eq", status: "active" }]);
  });

  it("never overwrites an existing name from a later request", async () => {
    await requestSignup(db, { phone: PHONE, name: "Original", groups: ["eq"], source: "web" });
    await requestSignup(db, { phone: PHONE, name: "Someone Else", groups: ["rs"], source: "web" });
    expect((await findMemberByPhone(db, PHONE))?.name).toBe("Original");
  });

  it("logs admin invites with the acting admin", async () => {
    await requestSignup(db, {
      phone: PHONE,
      groups: ["eq"],
      source: "admin",
      actor: "jared",
      detail: "asked at church",
    });
    expect(consentRows()).toEqual([
      { phone: PHONE, action: "invited", group_slug: "eq", source: "admin", actor: "jared" },
    ]);
  });

  it("rejects unknown or inactive groups without writing anything", async () => {
    await expect(requestSignup(db, { phone: PHONE, groups: ["eq", "nope"], source: "web" })).rejects.toThrow(
      UnknownGroupError,
    );
    sqlite.prepare("UPDATE groups SET active = 0 WHERE slug = 'rs'").run();
    await expect(requestSignup(db, { phone: PHONE, groups: ["rs"], source: "web" })).rejects.toThrow(
      "Unknown group: rs",
    );
    await expect(requestSignup(db, { phone: PHONE, groups: [], source: "web" })).rejects.toThrow(UnknownGroupError);
    expect(await findMemberByPhone(db, PHONE)).toBeNull();
  });
});
