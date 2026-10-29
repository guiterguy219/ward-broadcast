import { Hono } from "hono";
import { GROUPS, toE164 } from "./content";
import { HomePage, JoinPage, PrivacyPage, TermsPage, type JoinForm, type SiteConfig } from "./pages/pages";

export type Env = {
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
 * Validates the signup form. Saving and the confirmation text come with the
 * messaging build; until SIGNUPS_OPEN is "true" a valid form is acknowledged
 * but not stored.
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

  const errors: string[] = [];
  if (!form.name) errors.push("Enter your name.");
  if (!toE164(form.phone)) errors.push("Enter a 10-digit US mobile number.");
  if (form.groups.length === 0) errors.push("Choose at least one group.");
  if (!form.consent) errors.push("Check the box to agree to receive texts.");
  if (errors.length > 0) return c.html(<JoinPage config={config} form={form} errors={errors} />, 422);

  if (!config.signupsOpen) {
    return c.html(
      <JoinPage
        config={config}
        notice="Thanks! Texting hasn't started yet, so nothing was saved. Please sign up again once it's live."
      />,
    );
  }
  // Signups open: storing the member and sending the reply-YES text land with the messaging build.
  return c.text("Signups are not implemented yet.", 501);
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
