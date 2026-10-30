import { Hono } from "hono";
import { GROUPS, toE164 } from "./content";
import { requestSignup } from "./db";
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
  SIGNUPS_OPEN: string;
  TEXT_NUMBER: string;
  CONTACT_EMAIL: string;
};

const app = new Hono<{ Bindings: Env }>();

/** Reads display config from Worker vars. */
function siteConfig(env: Env): SiteConfig {
  return {
    textNumber: env.TEXT_NUMBER ?? "",
    contactEmail: env.CONTACT_EMAIL,
    signupsOpen: env.SIGNUPS_OPEN === "true",
  };
}

app.get("/", (c) => c.html(<HomePage config={siteConfig(c.env)} />));
app.get("/join", (c) => c.html(<JoinPage config={siteConfig(c.env)} />));
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
  const body = await c.req.parseBody({ all: true });
  const validSlugs: string[] = GROUPS.map((group) => group.slug);
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
    return c.html(<JoinPage config={config} form={form} errors={errors} />, 422);
  }

  if (!config.signupsOpen) {
    return c.html(
      <JoinPage
        config={config}
        notice="Thanks! Texting hasn't started yet, so nothing was saved. Please sign up again once it's live."
      />,
    );
  }
  const phone = toE164(form.phone) as string;
  await requestSignup(c.env.DB, {
    phone,
    name: form.name,
    groups: form.groups,
    source: "web",
    detail: `web form: groups=${form.groups.join(",")}; consent box checked`,
  });
  return c.html(
    <JoinPage
      config={config}
      notice="Thanks! Watch for a text from us and reply YES to finish signing up."
    />,
  );
});

/**
 * Telnyx messaging webhook. Acknowledges every event so Telnyx doesn't retry;
 * signature checks and keyword handling come with the messaging build.
 * Logs only the event type, never phone numbers or message text.
 */
app.post("/api/webhook", async (c) => {
  const event = await c.req.json().catch(() => null);
  console.log("telnyx webhook", event?.data?.event_type ?? "unparsed");
  return c.json({ received: true });
});

export default app;
