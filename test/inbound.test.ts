import { beforeEach, describe, expect, it } from "vitest";
import { findMemberByPhone } from "../src/db";
import { createApp, type Env } from "../src/index";
import { parseInbound } from "../src/inbound";
import { createTestDb } from "./d1";
import { createWebhookSigner, FakeSender, inboundEvent } from "./fakes";

const PHONE = "+18015550123";

describe("parseInbound", () => {
  it.each([
    ["STOP", "stop"],
    [" stop ", "stop"],
    ["Stop all", "stop"],
    ["Unsubscribe", "stop"],
    ["START", "start"],
    ["help", "help"],
    ["Yes!", "yes"],
    ["y", "yes"],
    ["join eq", "join"],
    ["LEAVE RS", "leave"],
    ["Can't stop by Saturday", "other"],
    ["I can help move!", "other"],
  ])("%s → %s", (text, action) => {
    expect(parseInbound(text).action).toBe(action);
  });
});

describe("inbound texts via the webhook", () => {
  let env: Env;
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let sender: FakeSender;
  let signer: Awaited<ReturnType<typeof createWebhookSigner>>;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const test = createTestDb();
    sqlite = test.sqlite;
    signer = await createWebhookSigner();
    sender = new FakeSender();
    env = {
      DB: test.db,
      SIGNUPS_OPEN: "true",
      TEXT_NUMBER: "+13858959493",
      CONTACT_EMAIL: "test@example.com",
      TELNYX_PUBLIC_KEY: signer.publicKey,
    };
    app = createApp({ makeSender: () => sender });
  });

  /** Sends a signed inbound text and returns the HTTP response. */
  async function text(body: string, from = PHONE, id?: string, envOverrides: Partial<Env> = {}) {
    const raw = inboundEvent(from, body, id);
    return app.request(
      "/api/webhook",
      { method: "POST", body: raw, headers: { "content-type": "application/json", ...(await signer.sign(raw)) } },
      { ...env, ...envOverrides },
    );
  }
  const lastReply = () => sender.to(PHONE).at(-1);
  const status = async () => (await findMemberByPhone(env.DB, PHONE))?.status;

  it("rejects unsigned or mis-signed webhooks", async () => {
    const raw = inboundEvent(PHONE, "JOIN EQ");
    const unsigned = await app.request("/api/webhook", { method: "POST", body: raw }, env);
    expect(unsigned.status).toBe(401);
    const noKey = await text("JOIN EQ", PHONE, undefined, { TELNYX_PUBLIC_KEY: undefined });
    expect(noKey.status).toBe(401);
    expect(sender.sent).toHaveLength(0);
  });

  it("JOIN EQ asks for YES; YES activates and sends the opt-in confirmation", async () => {
    await text("join eq");
    expect(lastReply()).toBe(
      "GibsonJ Broadcast: Reply YES to get Payson 10th Ward EQ texts, about 2 a week. Msg & data rates may apply. Reply HELP for help, STOP to opt out.",
    );
    expect(await status()).toBe("pending");

    await text("YES");
    expect(lastReply()).toBe(
      "GibsonJ Broadcast: You're signed up for Payson 10th Ward EQ texts, about 2 a week. Msg & data rates may apply. Reply HELP for help, STOP to opt out.",
    );
    expect(await status()).toBe("active");
    const actions = sqlite
      .prepare("SELECT action FROM consent_log ORDER BY id")
      .all()
      .map((row) => row.action);
    expect(actions).toEqual(["join_requested", "confirmed"]);
  });

  it("JOIN with an unknown group explains the options", async () => {
    await text("JOIN choir");
    expect(lastReply()).toContain("To sign up, text JOIN EQ or JOIN RS.");
    expect(await status()).toBeUndefined();
  });

  it("LEAVE drops one group and keeps the other", async () => {
    await text("JOIN EQ RS");
    await text("yes");
    await text("LEAVE RS");
    expect(lastReply()).toBe(
      "GibsonJ Broadcast: You've left Payson 10th Ward RS. You'll still get Payson 10th Ward EQ texts. Reply STOP to stop everything.",
    );
  });

  it("STOP stops everything, the web form can't undo it, and START restores the groups", async () => {
    await text("JOIN EQ");
    await text("YES");
    await text("STOP");
    expect(await status()).toBe("stopped");
    expect(lastReply()).toContain("You're unsubscribed");

    await app.request(
      "/join",
      {
        method: "POST",
        body: new URLSearchParams([
          ["name", "X"],
          ["phone", "8015550123"],
          ["groups", "eq"],
          ["consent", "yes"],
        ]),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
      env,
    );
    expect(await status()).toBe("stopped");

    await text("START");
    expect(await status()).toBe("active");
    expect(lastReply()).toBe(
      "GibsonJ Broadcast: Texts are turned back on for Payson 10th Ward EQ. Reply STOP to opt out.",
    );
  });

  it("YES with nothing pending is treated as a normal reply", async () => {
    await text("YES");
    expect(lastReply()).toContain("To sign up, text JOIN EQ or JOIN RS.");
  });

  it("other replies get the group's canned reply once per day, and are stored", async () => {
    await text("JOIN EQ");
    await text("YES");
    sender.sent = [];
    await text("I can help Saturday");
    expect(sender.to(PHONE)).toEqual([
      "Payson 10th Ward EQ: This number only sends announcements. For anything else, contact the EQ presidency: broadcast@gibsonj.net.",
    ]);
    await text("Also bringing a truck");
    expect(sender.to(PHONE)).toHaveLength(1);
    const stored = sqlite.prepare("SELECT text, auto_replied FROM replies ORDER BY id").all();
    expect(stored).toEqual([
      { text: "I can help Saturday", auto_replied: 1 },
      { text: "Also bringing a truck", auto_replied: 0 },
    ]);
  });

  it("ignores a redelivered webhook for the same message", async () => {
    await text("JOIN EQ", PHONE, "dup-1");
    const again = await text("JOIN EQ", PHONE, "dup-1");
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(sender.to(PHONE)).toHaveLength(1);
  });

  it("leaves STOP/HELP replies to Telnyx when KEYWORD_REPLIES is 'telnyx'", async () => {
    await text("HELP", PHONE, undefined, { KEYWORD_REPLIES: "telnyx" });
    await text("STOP", PHONE, undefined, { KEYWORD_REPLIES: "telnyx" });
    expect(sender.sent).toHaveLength(0);
    expect(await status()).toBe("stopped");
    expect(sqlite.prepare("SELECT action FROM consent_log").all()).toEqual([{ action: "stopped" }]);
  });

  it("still records state when Telnyx rejects the reply (e.g. 40010 before 10DLC approval)", async () => {
    sender.failWith = { code: "40010", error: "Not 10DLC registered" };
    const res = await text("JOIN EQ");
    expect(res.status).toBe(200);
    expect(await status()).toBe("pending");
  });

  it("a number that texted STOP without ever joining gets no further texts", async () => {
    await text("STOP");
    sender.sent = [];
    await text("who is this?");
    await app.request(
      "/join",
      {
        method: "POST",
        body: new URLSearchParams([
          ["name", "X"],
          ["phone", "8015550123"],
          ["groups", "eq"],
          ["consent", "yes"],
        ]),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
      env,
    );
    expect(sender.to(PHONE)).toEqual([]);
    expect(await status()).toBe("stopped");
  });

  it("JOIN after STOP needs a fresh YES and only restores the requested group", async () => {
    await text("JOIN EQ RS");
    await text("YES");
    await text("STOP");
    await text("JOIN EQ");
    expect(lastReply()).toContain("Reply YES to get Payson 10th Ward EQ texts");
    await text("YES");
    expect(lastReply()).toContain("You're signed up for Payson 10th Ward EQ texts");
    expect(await status()).toBe("active");
    const rows = sqlite.prepare("SELECT group_slug, status FROM memberships ORDER BY group_slug").all();
    expect(rows).toEqual([
      { group_slug: "eq", status: "active" },
      { group_slug: "rs", status: "left" },
    ]);
  });

  it("releases the claim when handling fails, so Telnyx's retry is processed", async () => {
    let calls = 0;
    const flaky = createApp({
      makeSender: () => ({
        send: async (to, body) => {
          calls += 1;
          if (calls === 1) throw new Error("boom");
          return sender.send(to, body);
        },
      }),
    });
    const raw = inboundEvent(PHONE, "JOIN EQ", "retry-1");
    const post = async () =>
      flaky.request("/api/webhook", { method: "POST", body: raw, headers: await signer.sign(raw) }, env);
    expect((await post()).status).toBe(500);
    expect((await post()).status).toBe(200);
    expect(sender.to(PHONE)).toHaveLength(1);
  });

  it("rate-limits confirmation texts from the web form", async () => {
    const signup = () =>
      app.request(
        "/join",
        {
          method: "POST",
          body: new URLSearchParams([
            ["name", "W"],
            ["phone", "8015550188"],
            ["groups", "eq"],
            ["consent", "yes"],
          ]),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        },
        env,
      );
    expect(await (await signup()).text()).toContain("Watch for a text");
    expect(await (await signup()).text()).toContain("already sent a confirmation text");
    expect(sender.to("+18015550188")).toHaveLength(1);
  });

  it("HELP returns the registered help text", async () => {
    await text("help");
    expect(lastReply()).toBe(
      "GibsonJ Broadcast is Jared Gibson's text service for the Payson 10th Ward EQ and RS. Questions: test@example.com. Reply STOP to opt out.",
    );
  });

  it("a web signup sends the reply-YES text", async () => {
    await app.request(
      "/join",
      {
        method: "POST",
        body: new URLSearchParams([
          ["name", "Web"],
          ["phone", "801-555-0199"],
          ["groups", "rs"],
          ["consent", "yes"],
        ]),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
      env,
    );
    expect(sender.to("+18015550199")).toEqual([
      "GibsonJ Broadcast: Reply YES to get Payson 10th Ward RS texts, about 2 a week. Msg & data rates may apply. Reply HELP for help, STOP to opt out.",
    ]);
  });
});
