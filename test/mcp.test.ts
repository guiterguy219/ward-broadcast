import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { adminForPassphrase } from "../src/auth";
import { processSendJob, type SendJob } from "../src/broadcasts";
import { createOAuthProvider, type Env } from "../src/index";
import { buildMcpServer } from "../src/mcp";
import { createTestDb } from "./d1";
import { FakeQueue, FakeSender } from "./fakes";

const PROGRAM = { programName: "GibsonJ Broadcast", operator: "Jared Gibson", contactEmail: "test@example.com" };

let db: D1Database;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
let queue: FakeQueue<SendJob>;
let sender: FakeSender;
let client: Client;

/** Calls a tool and returns its parsed JSON result (or the raw text for errors). */
async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = result.content[0]?.text ?? "";
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

function addActiveMember(phone: string, name: string, groups: string[]) {
  sqlite.prepare("INSERT INTO members (phone, name, status) VALUES (?, ?, 'active')").run(phone, name);
  const { id } = sqlite.prepare("SELECT id FROM members WHERE phone = ?").get(phone) as { id: number };
  for (const group of groups) {
    sqlite.prepare("INSERT INTO memberships (member_id, group_slug, status) VALUES (?, ?, 'active')").run(id, group);
  }
}

beforeEach(async () => {
  ({ db, sqlite } = createTestDb());
  queue = new FakeQueue<SendJob>();
  sender = new FakeSender();
  const server = buildMcpServer({
    db,
    queue: queue as unknown as Queue<SendJob>,
    sender,
    program: PROGRAM,
    signupLink: "broadcast.gibsonj.net/join",
    admin: "jared",
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
});

describe("MCP tools", () => {
  it("lists every admin tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "broadcast_status",
      "delete_template",
      "invite_member",
      "list_broadcasts",
      "list_groups",
      "list_members",
      "list_replies",
      "list_templates",
      "preview_broadcast",
      "remove_member",
      "save_template",
      "send_broadcast",
      "usage",
    ]);
  });

  it("core flow: save a template, preview it, send it, and see the result", async () => {
    addActiveMember("+18015550001", "Elder One", ["eq"]);
    addActiveMember("+18015550002", "Sister Two", ["rs"]);

    const saved = await call("save_template", {
      slug: "lesson-reminder",
      name: "Lesson reminder",
      body: 'Sunday {{sunday}} lesson is "{{topic}}."',
      defaultGroups: ["eq"],
      variables: { topic: { required: true } },
    });
    expect(saved.isError).toBe(false);

    const preview = await call("preview_broadcast", {
      template: "lesson-reminder",
      values: { topic: "Behold the Man" },
    });
    expect(preview.data).toMatchObject({ recipients: 1, segments: 1, encoding: "GSM-7", groups: ["eq"] });
    expect(preview.data.samples[0].text).toMatch(
      /^Payson 10th Ward EQ: Sunday \w+ \d+ lesson is "Behold the Man\." Reply STOP to opt out\.$/,
    );

    const sent = await call("send_broadcast", { preview_id: preview.data.previewId });
    expect(sent.data).toMatchObject({ recipients: 1, queueMessages: 1 });
    for (const job of queue.take()) await processSendJob(db, sender, job);
    expect(sender.to("+18015550001")).toHaveLength(1);
    expect(sender.to("+18015550002")).toHaveLength(0);

    const history = await call("list_broadcasts");
    expect(history.data[0]).toMatchObject({ author: "jared", status: "done", counts: { sent: 1 } });
    expect((await call("usage")).data).toMatchObject({ texts: 1, segments: 1 });
  });

  it("returns readable errors instead of failing", async () => {
    expect(await call("preview_broadcast", { template: "nope" })).toMatchObject({
      isError: true,
      text: 'No template named "nope".',
    });
    expect(await call("save_template", { slug: "x", name: "X", body: "Hi {{who}}" })).toMatchObject({
      isError: true,
      text: "Declare these variables: who",
    });
    expect(await call("send_broadcast", { preview_id: "pv_missing" })).toMatchObject({ isError: true });
  });

  it("invite_member records verbal consent and sends only the confirmation text", async () => {
    const invited = await call("invite_member", {
      phone: "(801) 555-0003",
      name: "New Elder",
      groups: ["eq"],
      note: "asked after class",
    });
    expect(invited.data).toEqual({ status: "pending", pendingGroups: ["eq"], confirmationText: "sent" });
    expect(sender.to("+18015550003")[0]).toContain("Reply YES to get Payson 10th Ward EQ texts");
    const log = sqlite.prepare("SELECT action, source, actor, detail FROM consent_log").get();
    expect(log).toEqual({ action: "invited", source: "admin", actor: "jared", detail: "asked after class" });
    const members = await call("list_members", { group: "eq" });
    expect(members.data[0]).toMatchObject({ name: "New Elder", status: "pending" });
  });

  it("invite_member refuses a number that texted STOP", async () => {
    sqlite.prepare("INSERT INTO members (phone, status) VALUES ('+18015550004', 'stopped')").run();
    const result = await call("invite_member", { phone: "8015550004", groups: ["eq"], note: "asked" });
    expect(result).toMatchObject({ isError: true });
    expect(sender.sent).toHaveLength(0);
  });

  it("remove_member leaves groups and logs who did it", async () => {
    addActiveMember("+18015550005", "Moving Away", ["eq", "rs"]);
    const removed = await call("remove_member", { phone: "801-555-0005", groups: ["rs"], reason: "asked" });
    expect(removed.data).toEqual({ removedFrom: ["rs"] });
    expect((await call("list_groups")).data.find((group: { slug: string }) => group.slug === "rs").activeMembers).toBe(
      0,
    );
  });
});

describe("MCP tool edge cases from review", () => {
  it("a partial save_template keeps the existing groups and variables", async () => {
    await call("save_template", {
      slug: "activity",
      name: "Activity",
      body: "{{what}} on {{when}}.",
      defaultGroups: ["rs"],
      variables: { what: { required: true }, when: { required: true } },
    });
    const edited = await call("save_template", { slug: "activity", name: "Activity", body: "{{what}} is {{when}}." });
    expect(edited.data).toMatchObject({ defaultGroups: ["rs"], variables: { what: { required: true } } });
  });

  it("remove_member rejects an empty group list instead of removing everything", async () => {
    addActiveMember("+18015550006", "Stays", ["eq", "rs"]);
    const result = await call("remove_member", { phone: "8015550006", groups: [], reason: "x" });
    expect(result.isError).toBe(true);
    expect((await call("list_groups")).data.map((group: { activeMembers: number }) => group.activeMembers)).toEqual([
      1, 1,
    ]);
  });

  it("usage counts texts Telnyx accepted, including ones that later failed delivery", async () => {
    addActiveMember("+18015550007", "A", ["eq"]);
    addActiveMember("+18015550008", "B", ["eq"]);
    const preview = await call("preview_broadcast", { groups: ["eq"], body: "Usage check" });
    await call("send_broadcast", { preview_id: preview.data.previewId });
    for (const job of queue.take()) await processSendJob(db, sender, job);
    sqlite.prepare("UPDATE outbox SET status = 'failed' WHERE telnyx_id = 'fake-2'").run();
    expect((await call("usage")).data).toMatchObject({ texts: 2, segments: 2 });
  });
});

describe("admin passphrases", () => {
  // SHA-256 of "correct horse battery staple"
  const keys = JSON.stringify({ jared: "c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a" });
  it("matches the right admin and rejects anything else", async () => {
    expect(await adminForPassphrase(keys, "correct horse battery staple")).toBe("jared");
    expect(await adminForPassphrase(keys, "wrong")).toBeNull();
    expect(await adminForPassphrase(keys, "")).toBeNull();
    expect(await adminForPassphrase(undefined, "correct horse battery staple")).toBeNull();
    expect(await adminForPassphrase("not json", "x")).toBeNull();
  });
});

describe("OAuth protection", () => {
  const kv = new Map<string, string>();
  const env = {
    DB: createTestDb().db,
    OAUTH_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => void kv.set(key, value),
      delete: async (key: string) => void kv.delete(key),
      list: async () => ({ keys: [], list_complete: true }),
    },
  } as unknown as Env;
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const provider = createOAuthProvider();

  it("rejects /mcp without a token and points clients at the metadata", async () => {
    const res = await provider.fetch(new Request("https://broadcast.gibsonj.net/mcp", { method: "POST" }), env, ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("publishes protected-resource and authorization-server metadata", async () => {
    const resource = await provider.fetch(
      new Request("https://broadcast.gibsonj.net/.well-known/oauth-protected-resource/mcp"),
      env,
      ctx,
    );
    expect(await resource.json()).toMatchObject({ resource: "https://broadcast.gibsonj.net/mcp" });
    const server = await provider.fetch(
      new Request("https://broadcast.gibsonj.net/.well-known/oauth-authorization-server"),
      env,
      ctx,
    );
    expect(await server.json()).toMatchObject({
      authorization_endpoint: "https://broadcast.gibsonj.net/authorize",
      registration_endpoint: "https://broadcast.gibsonj.net/oauth/register",
    });
  });

  it("still serves the public site", async () => {
    const res = await provider.fetch(new Request("https://broadcast.gibsonj.net/healthz"), env, ctx);
    expect(await res.text()).toBe("ok");
  });
});
