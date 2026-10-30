import { Hono } from "hono";
import { CONTACT_SERVING_SHORT, formatUsPhone, OPERATOR, PROGRAM_NAME, toE164 } from "./content";
import {
  allowWebConfirmation,
  claimInboundEvent,
  listActiveGroups,
  releaseInboundEvent,
  requestSignup,
  UnknownGroupError,
  type Group,
  type SignupResult,
} from "./db";
import { applyDeliveryStatus, processSendJob, type SendJob } from "./broadcasts";
import { handleInbound } from "./inbound";
import { confirmRequest, type ProgramConfig } from "./messages";
import { telnyxSender, verifyTelnyxSignature, type SmsSender, type TelnyxEvent } from "./telnyx";
import {
  HomePage,
  JoinPage,
  PrivacyPage,
  TermsPage,
  type JoinErrors,
  type JoinForm,
  type SiteConfig,
} from "./pages/pages";

export type Env = {
  DB: D1Database;
  /** Fan-out queue; each message is one chunk of outbox rows. */
  SEND_QUEUE: Queue<SendJob>;
  SIGNUPS_OPEN: string;
  TEXT_NUMBER: string;
  CONTACT_EMAIL: string;
  /** Secret: Telnyx API v2 key. */
  TELNYX_API_KEY?: string;
  /** Base64 Ed25519 public key from the Telnyx portal; webhooks are rejected without it. */
  TELNYX_PUBLIC_KEY?: string;
  /** "app" (default) or "telnyx": who answers STOP/START/HELP. */
  KEYWORD_REPLIES?: string;
};

/** Whether the web signup's confirmation text went out. */
type ConfirmationDelivery = "sent" | "failed" | "limited" | "not-needed";

export type AppOptions = {
  /** Builds the SMS sender; tests pass a fake. */
  makeSender?: (env: Env) => SmsSender;
};

/** Sender used in production; fails every send when no API key is configured. */
function defaultSender(env: Env): SmsSender {
  if (!env.TELNYX_API_KEY) return { send: async () => ({ ok: false, error: "TELNYX_API_KEY is not set" }) };
  return telnyxSender(env.TELNYX_API_KEY, env.TEXT_NUMBER);
}

/** Reads display config from Worker vars. */
function siteConfig(env: Env): SiteConfig {
  return {
    textNumber: env.TEXT_NUMBER ?? "",
    contactEmail: env.CONTACT_EMAIL,
    signupsOpen: env.SIGNUPS_OPEN === "true",
  };
}

function programConfig(env: Env): ProgramConfig {
  return { programName: PROGRAM_NAME, operator: OPERATOR, contactEmail: env.CONTACT_EMAIL };
}

/**
 * Builds the Worker's HTTP app.
 * @param options test seams (SMS sender)
 */
export function createApp(options: AppOptions = {}) {
  const makeSender = options.makeSender ?? defaultSender;
  const app = new Hono<{ Bindings: Env }>();

  app.get("/", (c) => c.html(<HomePage config={siteConfig(c.env)} />));
  app.get("/join", async (c) =>
    c.html(<JoinPage config={siteConfig(c.env)} groups={await listActiveGroups(c.env.DB)} />),
  );
  app.get("/terms", (c) => c.html(<TermsPage config={siteConfig(c.env)} />));
  app.get("/privacy", (c) => c.html(<PrivacyPage config={siteConfig(c.env)} />));
  app.get("/healthz", (c) => c.text("ok"));

  /**
   * Validates and stores a web signup as pending. The reply-YES confirmation
   * text is sent by the SMS layer. Until SIGNUPS_OPEN is "true" a valid form is
   * acknowledged but not stored.
   */
  app.post("/join", async (c) => {
    const config = siteConfig(c.env);
    const groups = await listActiveGroups(c.env.DB);
    const body = await c.req.parseBody({ all: true });
    const validSlugs = groups.map((group) => group.slug);
    const rawGroups = body.groups === undefined ? [] : [body.groups].flat();
    const form: JoinForm = {
      name: String(body.name ?? "").trim(),
      phone: String(body.phone ?? "").trim(),
      groups: rawGroups.map(String).filter((slug) => validSlugs.includes(slug)),
      consent: body.consent === "yes",
    };

    const errors: JoinErrors = {};
    if (!form.name) errors.name = "Enter your name.";
    if (!toE164(form.phone)) errors.phone = "Enter a 10-digit US mobile number, like (801) 555-0123.";
    if (form.groups.length === 0) errors.groups = "Choose at least one group.";
    if (!form.consent) errors.consent = "Check the box to agree to receive texts.";
    if (Object.keys(errors).length > 0) {
      return c.html(<JoinPage config={config} groups={groups} form={form} errors={errors} />, 422);
    }

    if (!config.signupsOpen) {
      return c.html(
        <JoinPage
          config={config}
          groups={groups}
          notice="Thanks! Texting hasn't started yet, so nothing was saved. Please sign up again once it's live."
        />,
      );
    }
    const phone = toE164(form.phone) as string;
    let result: SignupResult;
    try {
      result = await requestSignup(c.env.DB, {
        phone,
        name: form.name,
        groups: form.groups,
        source: "web",
        detail: `web form: groups=${form.groups.join(",")}; consent box checked`,
      });
    } catch (error) {
      if (!(error instanceof UnknownGroupError)) throw error;
      const groupErrors: JoinErrors = { groups: "That group isn't taking sign-ups right now. Choose another." };
      return c.html(<JoinPage config={config} groups={groups} form={form} errors={groupErrors} />, 422);
    }
    let delivery: ConfirmationDelivery = "not-needed";
    if (result.pendingGroups.length > 0) {
      delivery = "limited";
      if (await allowWebConfirmation(c.env.DB, phone)) {
        const pending = groups.filter((group) => result.pendingGroups.includes(group.slug));
        const sent = await makeSender(c.env).send(phone, confirmRequest(programConfig(c.env), pending));
        if (!sent.ok) console.error("signup confirmation failed", sent.code ?? "", sent.error);
        delivery = sent.ok ? "sent" : "failed";
      }
    }
    const notice = signupNotice(result, delivery, config, groups);
    return c.html(<JoinPage config={config} groups={groups} notice={notice} />);
  });

  /** What to tell someone after a valid signup, based on what actually changed. */
  /**
   * What to tell someone after a valid signup, based on what changed and whether
   * the confirmation text actually went out.
   */
  function signupNotice(
    result: SignupResult,
    delivery: ConfirmationDelivery,
    config: SiteConfig,
    groups: Group[],
  ): string {
    const where = config.textNumber ? ` to ${formatUsPhone(config.textNumber)}` : "";
    if (result.stopped) {
      return `This number opted out by texting STOP. To turn texts back on, text START${where} from that phone.`;
    }
    if (delivery === "not-needed") return "You're already signed up for those groups. No changes needed.";
    if (delivery === "sent") return "Thanks! Watch for a text from us and reply YES to finish signing up.";
    const keywords = groups.filter((group) => result.pendingGroups.includes(group.slug)).map((group) => group.keyword);
    const join = `JOIN ${keywords.join(" ")}`;
    return delivery === "limited"
      ? `We already sent a confirmation text to this number recently. Reply YES to it, or text ${join}${where}.`
      : `We saved your sign-up but couldn't send the confirmation text. To finish, text ${join}${where}.`;
  }

  /**
   * Telnyx messaging webhook. Rejects anything without a valid signature, ignores
   * redelivered messages, and handles inbound texts. Logs event types and
   * outcomes only, never phone numbers or message text.
   */
  app.post("/api/webhook", async (c) => {
    const rawBody = await c.req.text();
    const valid = await verifyTelnyxSignature({
      publicKey: c.env.TELNYX_PUBLIC_KEY,
      signature: c.req.header("telnyx-signature-ed25519"),
      timestamp: c.req.header("telnyx-timestamp"),
      rawBody,
    });
    if (!valid) return c.json({ error: "invalid signature" }, 401);

    let event: TelnyxEvent;
    try {
      event = JSON.parse(rawBody) as TelnyxEvent;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const type = event.data?.event_type ?? "unknown";
    const payload = event.data?.payload;
    if (type === "message.finalized" && payload?.id) {
      const recipient = payload.to?.[0];
      const error = payload.errors?.map((item) => [item.code, item.title].filter(Boolean).join(" ")).join("; ");
      await applyDeliveryStatus(c.env.DB, payload.id, recipient?.status ?? "unknown", error || undefined);
      return c.json({ received: true });
    }
    if (type !== "message.received") {
      console.log("telnyx webhook", type);
      return c.json({ received: true });
    }

    const from = payload?.from?.phone_number;
    const messageId = payload?.id ?? event.data?.id;
    if (!from || !messageId) return c.json({ error: "missing sender or id" }, 400);
    if (!(await claimInboundEvent(c.env.DB, messageId))) return c.json({ received: true, duplicate: true });

    try {
      const outcome = await handleInbound(
        {
          db: c.env.DB,
          sender: makeSender(c.env),
          program: programConfig(c.env),
          serving: CONTACT_SERVING_SHORT,
          appRepliesToKeywords: c.env.KEYWORD_REPLIES !== "telnyx",
        },
        from,
        payload?.text ?? "",
      );
      console.log("inbound", outcome.action, outcome.replied ? "replied" : "no reply");
      return c.json({ received: true });
    } catch (error) {
      // Release the claim and fail so Telnyx retries; a lost STOP is worse than a repeated reply.
      await releaseInboundEvent(c.env.DB, messageId);
      console.error("inbound handling failed", (error as Error).message);
      return c.json({ error: "processing failed" }, 500);
    }
  });

  return app;
}

/**
 * Queue consumer: sends each chunk and retries it (with backoff) if any
 * recipient hit a transient error. Rows already sent are skipped on retry.
 */
export function createQueueHandler(options: AppOptions = {}) {
  const makeSender = options.makeSender ?? defaultSender;
  return async (batch: MessageBatch<SendJob>, env: Env): Promise<void> => {
    const sender = makeSender(env);
    for (const message of batch.messages) {
      try {
        const retry = await processSendJob(env.DB, sender, message.body);
        if (retry) message.retry({ delaySeconds: 30 });
        else message.ack();
      } catch (error) {
        console.error("send job failed", message.body.broadcastId, (error as Error).message);
        message.retry({ delaySeconds: 30 });
      }
    }
  };
}

export default {
  fetch: createApp().fetch,
  queue: createQueueHandler(),
} satisfies ExportedHandler<Env, SendJob>;
