import { beforeEach, describe, expect, it } from "vitest";
import {
  applyDeliveryStatus,
  BroadcastError,
  broadcastStatus,
  composeText,
  FOOTER,
  previewBroadcast,
  processSendJob,
  SEND_CHUNK_SIZE,
  sendBroadcast,
  type SendJob,
} from "../src/broadcasts";
import { createApp, createQueueHandler, type Env } from "../src/index";
import { segmentInfo } from "../src/segments";
import { saveTemplate, TemplateError } from "../src/templates";
import { createTestDb } from "./d1";
import { createWebhookSigner, FakeQueue, FakeSender } from "./fakes";

const LINK = "broadcast.gibsonj.net/join";
const SATURDAY = new Date("2026-11-07T18:00:00Z"); // Sat Nov 7, 11 am in Utah

let db: D1Database;
let sqlite: ReturnType<typeof createTestDb>["sqlite"];
let queue: FakeQueue<SendJob>;
let sender: FakeSender;

/** Adds an active member in the given groups. */
function addMember(phone: string, groups: string[], status = "active") {
  sqlite.prepare("INSERT INTO members (phone, status) VALUES (?, ?)").run(phone, status);
  const id = (sqlite.prepare("SELECT id FROM members WHERE phone = ?").get(phone) as { id: number }).id;
  for (const group of groups) {
    sqlite.prepare("INSERT INTO memberships (member_id, group_slug, status) VALUES (?, ?, 'active')").run(id, group);
  }
}

/** Runs every queued job through the consumer logic until the queue is empty. */
async function drain() {
  for (let round = 0; round < 10 && queue.messages.length > 0; round += 1) {
    for (const job of queue.take()) {
      if (await processSendJob(db, sender, job)) queue.messages.push(job);
    }
  }
}

beforeEach(async () => {
  ({ db, sqlite } = createTestDb());
  queue = new FakeQueue<SendJob>();
  sender = new FakeSender();
  await saveTemplate(db, {
    slug: "lesson-reminder",
    name: "Lesson reminder",
    body: 'Sunday {{sunday}} lesson is "{{topic}}." {{extra}}',
    defaultGroups: ["eq"],
    variables: { topic: { required: true }, extra: { default: "" } },
  });
});

describe("composeText", () => {
  it("adds the footer when it fits in the same segment, and always on a first text of the month", () => {
    expect(composeText("Payson 10th Ward EQ", "Short note.", false)).toBe(`Payson 10th Ward EQ: Short note. ${FOOTER}`);
    const long = "x".repeat(130);
    expect(composeText("Payson 10th Ward EQ", long, false)).toBe(`Payson 10th Ward EQ: ${long}`);
    expect(composeText("Payson 10th Ward EQ", long, true)).toBe(`Payson 10th Ward EQ: ${long} ${FOOTER}`);
  });
});

describe("previewBroadcast", () => {
  it("renders a template with built-ins and reports recipients, segments, and cost", async () => {
    addMember("+18015550001", ["eq"]);
    addMember("+18015550002", ["eq", "rs"]);
    addMember("+18015550003", ["rs"]);
    addMember("+18015550004", ["eq"], "stopped");

    const preview = await previewBroadcast(
      db,
      { author: "jared", templateSlug: "lesson-reminder", values: { topic: "Behold the Man" }, now: SATURDAY },
      LINK,
    );
    expect(preview.body).toBe('Sunday Nov 8 lesson is "Behold the Man."');
    expect(preview.groups).toEqual(["eq"]);
    expect(preview.recipients).toBe(2);
    expect(preview.segments).toBe(1);
    expect(preview.encoding).toBe("GSM-7");
    expect(preview.samples).toEqual([
      {
        group: "eq",
        text: `Payson 10th Ward EQ: Sunday Nov 8 lesson is "Behold the Man." ${FOOTER}`,
        segments: 1,
      },
    ]);
    expect(preview.previewId).toMatch(/^pv_[0-9a-f]{32}$/);
  });

  it("replaces curly quotes and flags emoji that force UCS-2", async () => {
    addMember("+18015550001", ["eq"]);
    const preview = await previewBroadcast(
      db,
      { author: "jared", groups: ["eq"], body: "It’s potluck night \u{1F372}" },
      LINK,
    );
    expect(preview.body).toBe("It's potluck night \u{1F372}");
    expect(preview.encoding).toBe("UCS-2");
    expect(preview.nonGsmChars).toEqual(["\u{1F372}"]);
  });

  it("explains missing variables, unknown groups, and ambiguous input", async () => {
    await expect(previewBroadcast(db, { author: "j", templateSlug: "lesson-reminder" }, LINK)).rejects.toThrow(
      new TemplateError("Missing required variable: topic"),
    );
    await expect(previewBroadcast(db, { author: "j", groups: ["choir"], body: "hi" }, LINK)).rejects.toThrow(
      "Unknown or inactive group: choir",
    );
    await expect(
      previewBroadcast(db, { author: "j", templateSlug: "lesson-reminder", body: "hi" }, LINK),
    ).rejects.toThrow(BroadcastError);
  });
});

describe("sendBroadcast + queue consumer", () => {
  it("sends each recipient exactly one text, deduplicated across groups", async () => {
    addMember("+18015550001", ["eq"]);
    addMember("+18015550002", ["eq", "rs"]);
    addMember("+18015550003", ["rs"]);
    const preview = await previewBroadcast(
      db,
      { author: "jared", groups: ["eq", "rs"], body: "Activity Thursday at 7." },
      LINK,
    );
    const summary = await sendBroadcast(db, queue as unknown as Queue<SendJob>, {
      previewId: preview.previewId,
      author: "jared",
    });
    expect(summary).toMatchObject({ recipients: 3, queueMessages: 1 });

    await drain();
    expect(sender.sent.map((message) => [message.to, message.text.split(":")[0]])).toEqual([
      ["+18015550001", "Payson 10th Ward EQ"],
      ["+18015550002", "Payson 10th Ward EQ"],
      ["+18015550003", "Payson 10th Ward RS"],
    ]);
    expect(await broadcastStatus(db, summary.broadcastId)).toMatchObject({ status: "done", counts: { sent: 3 } });
  });

  it("refuses to reuse, share, or send an expired preview", async () => {
    addMember("+18015550001", ["eq"]);
    const preview = await previewBroadcast(db, { author: "jared", groups: ["eq"], body: "Hi" }, LINK);
    const q = queue as unknown as Queue<SendJob>;
    await expect(sendBroadcast(db, q, { previewId: preview.previewId, author: "someone-else" })).rejects.toThrow(
      BroadcastError,
    );
    await sendBroadcast(db, q, { previewId: preview.previewId, author: "jared" });
    await expect(sendBroadcast(db, q, { previewId: preview.previewId, author: "jared" })).rejects.toThrow(
      "already sent",
    );

    const old = await previewBroadcast(
      db,
      { author: "jared", groups: ["eq"], body: "Old", now: new Date("2020-01-01T00:00:00Z") },
      LINK,
    );
    await expect(sendBroadcast(db, q, { previewId: old.previewId, author: "jared" })).rejects.toThrow("expired");
  });

  it("splits large sends into chunks and skips anyone who opted out after queueing", async () => {
    for (let index = 0; index < SEND_CHUNK_SIZE + 5; index += 1) addMember(`+1801555${String(1000 + index)}`, ["eq"]);
    const preview = await previewBroadcast(db, { author: "jared", groups: ["eq"], body: "Big send" }, LINK);
    const summary = await sendBroadcast(db, queue as unknown as Queue<SendJob>, {
      previewId: preview.previewId,
      author: "jared",
    });
    expect(summary.queueMessages).toBe(2);
    expect(queue.messages[0].outboxIds).toHaveLength(SEND_CHUNK_SIZE);

    sqlite.prepare("UPDATE members SET status = 'stopped' WHERE phone = '+18015551000'").run();
    await drain();
    expect(sender.sent).toHaveLength(SEND_CHUNK_SIZE + 4);
    expect(await broadcastStatus(db, summary.broadcastId)).toMatchObject({
      status: "done",
      counts: { sent: SEND_CHUNK_SIZE + 4, skipped: 1 },
    });
  });

  it("retries transient failures without re-texting anyone, and fails permanent errors", async () => {
    addMember("+18015550001", ["eq"]);
    addMember("+18015550002", ["eq"]);
    const preview = await previewBroadcast(db, { author: "jared", groups: ["eq"], body: "Retry test" }, LINK);
    const summary = await sendBroadcast(db, queue as unknown as Queue<SendJob>, {
      previewId: preview.previewId,
      author: "jared",
    });

    let calls = 0;
    const flaky = {
      send: async (to: string, text: string) => {
        calls += 1;
        if (to === "+18015550002" && calls === 2) return { ok: false as const, error: "HTTP 503" };
        return sender.send(to, text);
      },
    };
    const [job] = queue.take();
    expect(await processSendJob(db, flaky, job)).toBe(true);
    expect(await processSendJob(db, flaky, job)).toBe(false);
    expect(sender.to("+18015550001")).toHaveLength(1);
    expect(sender.to("+18015550002")).toHaveLength(1);

    sender.failWith = { code: "40010", error: "Not 10DLC registered" };
    addMember("+18015550003", ["rs"]);
    const second = await previewBroadcast(db, { author: "jared", groups: ["rs"], body: "Blocked" }, LINK);
    const blocked = await sendBroadcast(db, queue as unknown as Queue<SendJob>, {
      previewId: second.previewId,
      author: "jared",
    });
    await drain();
    expect(await broadcastStatus(db, blocked.broadcastId)).toMatchObject({ status: "done", counts: { failed: 1 } });
    expect(await broadcastStatus(db, summary.broadcastId)).toMatchObject({ counts: { sent: 2 } });
  });

  it("saves each send immediately, so a crash mid-chunk never re-texts anyone", async () => {
    for (const phone of ["+18015550001", "+18015550002", "+18015550003"]) addMember(phone, ["eq"]);
    const preview = await previewBroadcast(db, { author: "jared", groups: ["eq"], body: "Crash" }, LINK);
    await sendBroadcast(db, queue as unknown as Queue<SendJob>, { previewId: preview.previewId, author: "jared" });
    const [job] = queue.take();
    const crashing = {
      send: async (to: string, text: string) => {
        if (sender.sent.length === 2) throw new Error("worker died");
        return sender.send(to, text);
      },
    };
    await expect(processSendJob(db, crashing, job)).rejects.toThrow("worker died");
    await processSendJob(db, sender, job);
    expect(sender.sent.map((message) => message.to)).toEqual(["+18015550001", "+18015550002", "+18015550003"]);
  });

  it("retries rate limits (429) and skips a member who left the group after queueing", async () => {
    addMember("+18015550001", ["eq"]);
    addMember("+18015550002", ["eq", "rs"]);
    const preview = await previewBroadcast(db, { author: "jared", groups: ["eq"], body: "Rate" }, LINK);
    const { broadcastId } = await sendBroadcast(db, queue as unknown as Queue<SendJob>, {
      previewId: preview.previewId,
      author: "jared",
    });
    sqlite
      .prepare(
        "UPDATE memberships SET status = 'left' WHERE group_slug = 'eq' AND member_id = (SELECT id FROM members WHERE phone = '+18015550002')",
      )
      .run();
    let first = true;
    const limited = {
      send: async (to: string, text: string) => {
        if (first) {
          first = false;
          return { ok: false as const, status: 429, code: "10011", error: "Too many requests" };
        }
        return sender.send(to, text);
      },
    };
    const [job] = queue.take();
    expect(await processSendJob(db, limited, job)).toBe(true);
    expect(await processSendJob(db, limited, job)).toBe(false);
    expect(await broadcastStatus(db, broadcastId)).toMatchObject({ counts: { sent: 1, skipped: 1 } });
  });

  it("cancels the broadcast and says so when enqueueing fails", async () => {
    addMember("+18015550001", ["eq"]);
    const preview = await previewBroadcast(db, { author: "jared", groups: ["eq"], body: "Queue down" }, LINK);
    const broken = { sendBatch: async () => Promise.reject(new Error("queue unavailable")) };
    await expect(
      sendBroadcast(db, broken as unknown as Queue<SendJob>, { previewId: preview.previewId, author: "jared" }),
    ).rejects.toThrow("was cancelled");
    const row = sqlite.prepare("SELECT status FROM broadcasts").get();
    expect(row).toEqual({ status: "done" });
    expect(sqlite.prepare("SELECT status, error FROM outbox").all()).toEqual([
      { status: "failed", error: "enqueue failed" },
    ]);
  });

  it("records delivery results from Telnyx", async () => {
    addMember("+18015550001", ["eq"]);
    addMember("+18015550002", ["eq"]);
    const preview = await previewBroadcast(db, { author: "jared", groups: ["eq"], body: "Delivery" }, LINK);
    const { broadcastId } = await sendBroadcast(db, queue as unknown as Queue<SendJob>, {
      previewId: preview.previewId,
      author: "jared",
    });
    await drain();
    await applyDeliveryStatus(db, "fake-1", "delivered");
    await applyDeliveryStatus(db, "fake-2", "delivery_failed", "30007 carrier filtered");
    expect(await broadcastStatus(db, broadcastId)).toMatchObject({ counts: { delivered: 1, failed: 1 } });
  });
});

describe("worker wiring", () => {
  it("the queue handler acks finished chunks; message.finalized webhooks update delivery", async () => {
    addMember("+18015550001", ["eq"]);
    const signer = await createWebhookSigner();
    const env: Env = {
      DB: db,
      SEND_QUEUE: queue as unknown as Queue<SendJob>,
      SIGNUPS_OPEN: "false",
      TEXT_NUMBER: "+13858959493",
      CONTACT_EMAIL: "test@example.com",
      TELNYX_PUBLIC_KEY: signer.publicKey,
    };
    const preview = await previewBroadcast(db, { author: "jared", groups: ["eq"], body: "Wiring" }, LINK);
    const { broadcastId } = await sendBroadcast(db, env.SEND_QUEUE, { previewId: preview.previewId, author: "jared" });

    const acked: number[] = [];
    const handler = createQueueHandler({ makeSender: () => sender });
    const jobs = queue.take();
    await handler(
      {
        messages: jobs.map((body, index) => ({
          body,
          ack: () => acked.push(index),
          retry: () => {
            throw new Error("unexpected retry");
          },
        })),
      } as unknown as MessageBatch<SendJob>,
      env,
    );
    expect(acked).toEqual([0]);

    const raw = JSON.stringify({
      data: {
        event_type: "message.finalized",
        payload: { id: "fake-1", to: [{ phone_number: "+18015550001", status: "delivered" }] },
      },
    });
    const res = await createApp().request(
      "/api/webhook",
      { method: "POST", body: raw, headers: await signer.sign(raw) },
      env,
    );
    expect(res.status).toBe(200);
    expect(await broadcastStatus(db, broadcastId)).toMatchObject({ counts: { delivered: 1 } });
  });
});

describe("segmentInfo", () => {
  it.each([
    ["a".repeat(160), "GSM-7", 1],
    ["a".repeat(161), "GSM-7", 2],
    ["{".repeat(80), "GSM-7", 1],
    ["{".repeat(81), "GSM-7", 2],
    ["’".repeat(70), "UCS-2", 1],
    ["’".repeat(71), "UCS-2", 2],
  ])("%#: %s chars", (text, encoding, segments) => {
    expect(segmentInfo(text)).toMatchObject({ encoding, segments });
  });
});
