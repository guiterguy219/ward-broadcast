import {
  EFFECTIVE_DATE,
  FREQUENCY,
  GROUPS,
  KEYWORDS,
  PROGRAM_NAME,
  RATES,
  formatUsPhone,
} from "../content";
import { Layout } from "./Layout";

export type SiteConfig = {
  /** E.164 Telnyx number, or "" when not configured yet. */
  textNumber: string;
  contactEmail: string;
  signupsOpen: boolean;
};

/** One-line description under each group's checkbox. */
const GROUP_BLURBS: Record<string, string> = {
  eq: "Lessons, service requests, quorum activities",
  rs: "Lessons, service requests, Relief Society activities",
};

/** Texted phone number as a tappable sms: link. */
function NumberLink({ textNumber }: { textNumber: string }) {
  return <a href={`sms:${textNumber}`}>{formatUsPhone(textNumber)}</a>;
}

/** "Prefer texting?" alternative, shown only once the number is configured. */
function TextToJoin({ textNumber }: { textNumber: string }) {
  if (!textNumber) return null;
  return (
    <p class="alt-path muted">
      Prefer texting? Send <strong>JOIN EQ</strong> or <strong>JOIN RS</strong> to{" "}
      <NumberLink textNumber={textNumber} />, then reply YES.
    </p>
  );
}

export function HomePage({ config }: { config: SiteConfig }) {
  return (
    <Layout title="Home">
      <h1>Ward announcements, sent as plain texts</h1>
      <p class="lead">
        Lesson reminders, service requests, and activity news from the Elders Quorum and Relief
        Society presidencies. No app to install.
      </p>
      <div class="actions">
        <a class="button" href="/join">
          Sign up
        </a>
        {config.textNumber && (
          <span class="muted small">
            or text <strong>JOIN EQ</strong> or <strong>JOIN RS</strong> to{" "}
            <NumberLink textNumber={config.textNumber} />
          </span>
        )}
      </div>

      <h2>How it works</h2>
      <ol class="steps">
        <li>
          <div>
            <strong>Sign up</strong>
            <span class="muted">Here, by text, or by asking a presidency member at church.</span>
          </div>
        </li>
        <li>
          <div>
            <strong>Reply YES</strong>
            <span class="muted">We text you once to confirm. Nothing else arrives until you do.</span>
          </div>
        </li>
        <li>
          <div>
            <strong>Get about two texts a week</strong>
            <span class="muted">Reply STOP any time and they stop.</span>
          </div>
        </li>
      </ol>

      <h2>Questions?</h2>
      <p>
        Email <a href={`mailto:${config.contactEmail}`}>{config.contactEmail}</a>, or talk to a
        member of your quorum or Relief Society presidency.
      </p>
    </Layout>
  );
}

export type JoinForm = { name: string; phone: string; groups: string[]; consent: boolean };
export type JoinErrors = Partial<Record<"name" | "phone" | "groups" | "consent", string>>;

/** Inline error under a field, linked to it via aria-describedby. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <span class="field-error" id={id}>
      {message}
    </span>
  );
}

export function JoinPage({
  config,
  form = { name: "", phone: "", groups: [], consent: false },
  errors = {},
  notice,
}: {
  config: SiteConfig;
  form?: JoinForm;
  errors?: JoinErrors;
  notice?: string;
}) {
  const errorCount = Object.keys(errors).length;
  return (
    <Layout title="Sign up">
      <h1>Sign up for ward texts</h1>
      <p class="lead">Takes under a minute. We'll text you once to confirm.</p>

      {!config.signupsOpen && !notice && (
        <div class="notice notice-info">
          <p>
            <strong>Texting starts soon.</strong> Until then, this form doesn't save anything.
          </p>
        </div>
      )}

      <form method="post" action="/join" class="panel" novalidate>
        {notice && (
          <div class="notice notice-ok" role="status">
            <p>{notice}</p>
          </div>
        )}
        {errorCount > 0 && (
          <div class="notice notice-error" role="alert">
            <p>
              <strong>
                {errorCount === 1 ? "One thing needs fixing" : `${errorCount} things need fixing`}
              </strong>{" "}
              before you can sign up.
            </p>
          </div>
        )}

        <div class="field">
          <label class="label" for="name">
            Your name
          </label>
          <input
            class="input"
            type="text"
            id="name"
            name="name"
            autocomplete="name"
            value={form.name}
            required
            aria-invalid={errors.name ? "true" : undefined}
            aria-describedby={errors.name ? "name-error" : undefined}
          />
          <FieldError id="name-error" message={errors.name} />
        </div>

        <div class="field">
          <label class="label" for="phone">
            Mobile number
          </label>
          <span class="hint" id="phone-hint">
            A US cell phone that can get texts
          </span>
          <input
            class="input"
            type="tel"
            id="phone"
            name="phone"
            autocomplete="tel"
            inputmode="tel"
            placeholder="(801) 555-0123"
            value={form.phone}
            required
            aria-invalid={errors.phone ? "true" : undefined}
            aria-describedby={errors.phone ? "phone-hint phone-error" : "phone-hint"}
          />
          <FieldError id="phone-error" message={errors.phone} />
        </div>

        <fieldset aria-describedby={errors.groups ? "groups-error" : undefined}>
          <legend>Which groups?</legend>
          <div class="options">
            {GROUPS.map((group) => (
              <label class="option">
                <input
                  type="checkbox"
                  name="groups"
                  value={group.slug}
                  checked={form.groups.includes(group.slug)}
                />
                <span class="option-text">
                  <strong>{group.name}</strong>
                  <span>{GROUP_BLURBS[group.slug]}</span>
                </span>
              </label>
            ))}
          </div>
          <FieldError id="groups-error" message={errors.groups} />
        </fieldset>

        <div class="consent-wrap">
          <label class="consent">
            <input
              type="checkbox"
              name="consent"
              value="yes"
              checked={form.consent}
              aria-describedby={errors.consent ? "consent-error" : undefined}
            />
            <span>
              I agree to receive recurring text messages from {PROGRAM_NAME} at this number.{" "}
              {FREQUENCY} {RATES} {KEYWORDS} Signing up is never required to take part in the ward.
              See the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.
            </span>
          </label>
          <FieldError id="consent-error" message={errors.consent} />
        </div>

        <div class="submit-row">
          <button class="button" type="submit">
            Sign up
          </button>
          <span class="muted small">You're signed up only after you reply YES to our text.</span>
        </div>
      </form>

      <TextToJoin textNumber={config.textNumber} />
    </Layout>
  );
}

export function TermsPage({ config }: { config: SiteConfig }) {
  return (
    <Layout title="Terms">
      <div class="prose">
        <h1>Text message terms</h1>
        <p class="effective">Effective {EFFECTIVE_DATE}</p>
        <h2>What this is</h2>
        <p>
          {PROGRAM_NAME} sends recurring text messages to members of the Payson 10th Ward Elders
          Quorum and Relief Society who sign up: lesson reminders, service requests, and activity
          announcements. Messages start with the group name, such as "Payson 10th Ward EQ:".
        </p>
        <h2>Signing up</h2>
        <p>
          Sign up on this website, by texting JOIN EQ or JOIN RS to our number, or by asking a
          presidency member to add you. Every sign-up is confirmed by text, and you're subscribed
          only after you reply YES.
        </p>
        <h2>Frequency and cost</h2>
        <p>
          {FREQUENCY} {RATES} There is no charge from us.
        </p>
        <h2>Opting out and help</h2>
        <p>
          Reply STOP to stop all messages; you'll get one confirmation text. Reply LEAVE EQ or LEAVE
          RS to leave one group. Reply START to rejoin. Reply HELP for contact information, or email{" "}
          <a href={`mailto:${config.contactEmail}`}>{config.contactEmail}</a>.
        </p>
        <h2>Replies</h2>
        <p>
          This number sends announcements only. Replies get an automatic message with presidency
          contact information.
        </p>
        <h2>Acceptable use</h2>
        <p>
          Messages are only for quorum and Relief Society business. They are never used for
          political, commercial, or personal purposes.
        </p>
        <h2>Delivery</h2>
        <p>
          Carriers are not liable for delayed or undelivered messages. Delivery isn't guaranteed and
          may depend on your carrier and phone settings.
        </p>
        <h2>Privacy</h2>
        <p>
          See the <a href="/privacy">privacy policy</a>.
        </p>
      </div>
    </Layout>
  );
}

export function PrivacyPage({ config }: { config: SiteConfig }) {
  return (
    <Layout title="Privacy">
      <div class="prose">
        <h1>Privacy policy</h1>
        <p class="effective">Effective {EFFECTIVE_DATE}</p>
        <h2>What we collect</h2>
        <ul>
          <li>Your name and mobile number.</li>
          <li>Which groups you joined.</li>
          <li>A record of your consent: when and how you signed up, confirmed, or opted out.</li>
          <li>Delivery status of messages sent to you, and any texts you send to the number.</li>
        </ul>
        <p>We don't collect anything from Church records or directories. You give us your number.</p>
        <h2>How we use it</h2>
        <p>
          Only to send the {PROGRAM_NAME} texts you signed up for and to answer HELP and STOP
          requests. Only the quorum and Relief Society presidency members who run these texts can
          see the list.
        </p>
        <h2>Sharing</h2>
        <p>
          We do not sell, rent, or share your information. No mobile information will be shared with
          third parties or affiliates for marketing or promotional purposes. Text messaging opt-in
          data and consent are not shared with any third parties.
        </p>
        <p>
          Two service providers process your number only to run this service: Telnyx, which
          delivers the texts, and Cloudflare, which hosts this site and its data.
        </p>
        <h2>Keeping and deleting it</h2>
        <p>
          If you opt out, we stop texting you and delete your name and group memberships. We keep
          the opt-out record so we never text you again by mistake. To have everything deleted,
          email <a href={`mailto:${config.contactEmail}`}>{config.contactEmail}</a>.
        </p>
      </div>
    </Layout>
  );
}
