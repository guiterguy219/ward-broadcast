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

/** "JOIN EQ" / "JOIN RS" instructions, shown only once the number is configured. */
function TextToJoin({ textNumber }: { textNumber: string }) {
  if (!textNumber) return null;
  return (
    <p>
      Or text <strong>JOIN EQ</strong> or <strong>JOIN RS</strong> to{" "}
      <a href={`sms:${textNumber}`}>{formatUsPhone(textNumber)}</a>, then reply YES.
    </p>
  );
}

export function HomePage({ config }: { config: SiteConfig }) {
  return (
    <Layout title="Home">
      <h1>{PROGRAM_NAME}</h1>
      <p>
        Text reminders from the Payson 10th Ward Elders Quorum and Relief Society presidencies:
        upcoming lesson topics, service requests like help with a move, and activity
        announcements.
      </p>
      <p>It's plain text messaging, so there's no app to install. Join or leave any time.</p>
      <p>
        <a class="button" href="/join">Sign up for texts</a>
      </p>
      <TextToJoin textNumber={config.textNumber} />
      <h2>Questions</h2>
      <p>
        Email <a href={`mailto:${config.contactEmail}`}>{config.contactEmail}</a> or talk to a
        member of your quorum or Relief Society presidency.
      </p>
    </Layout>
  );
}

export type JoinForm = { name: string; phone: string; groups: string[]; consent: boolean };

export function JoinPage({
  config,
  form = { name: "", phone: "", groups: [], consent: false },
  errors = [],
  notice,
}: {
  config: SiteConfig;
  form?: JoinForm;
  errors?: string[];
  notice?: string;
}) {
  return (
    <Layout title="Sign up">
      <h1>Sign up for ward texts</h1>
      {!config.signupsOpen && (
        <p class="notice ok">
          Texting starts soon. Until then this form doesn't save anything; check back shortly.
        </p>
      )}
      <form method="post" action="/join" class="card" novalidate>
        {notice && <p class="notice ok">{notice}</p>}
        {errors.length > 0 && (
          <div class="notice error" role="alert">
            {errors.map((error) => (
              <p>{error}</p>
            ))}
          </div>
        )}
        <div class="field">
          <label for="name">Your name</label>
          <input type="text" id="name" name="name" autocomplete="name" value={form.name} required />
        </div>
        <div class="field">
          <label for="phone">Mobile number</label>
          <input
            type="tel"
            id="phone"
            name="phone"
            autocomplete="tel"
            inputmode="tel"
            placeholder="(801) 555-0123"
            value={form.phone}
            required
          />
        </div>
        <fieldset>
          <legend>Which groups?</legend>
          {GROUPS.map((group) => (
            <label class="check">
              <input
                type="checkbox"
                name="groups"
                value={group.slug}
                checked={form.groups.includes(group.slug)}
              />
              <span>{group.name}</span>
            </label>
          ))}
        </fieldset>
        <label class="check">
          <input type="checkbox" name="consent" value="yes" checked={form.consent} />
          <span>
            I agree to receive recurring text messages from {PROGRAM_NAME} at the number above.{" "}
            {FREQUENCY} {RATES} {KEYWORDS} Consent is not required to participate in the ward.
            See the <a href="/terms">terms</a> and <a href="/privacy">privacy policy</a>.
          </span>
        </label>
        <p class="fine">
          After you submit, we'll text you to confirm. You're signed up only after you reply YES.
        </p>
        <button type="submit">Sign up</button>
      </form>
      <TextToJoin textNumber={config.textNumber} />
    </Layout>
  );
}

export function TermsPage({ config }: { config: SiteConfig }) {
  return (
    <Layout title="Terms">
      <h1>Text message terms</h1>
      <p class="fine">Effective {EFFECTIVE_DATE}</p>
      <h2>What this is</h2>
      <p>
        {PROGRAM_NAME} sends recurring text messages to members of the Payson 10th Ward Elders
        Quorum and Relief Society who sign up: lesson reminders, service requests, and activity
        announcements. Messages start with the group name, such as "Payson 10th Ward EQ:".
      </p>
      <h2>Signing up</h2>
      <p>
        Sign up on this website, by texting JOIN EQ or JOIN RS to our number, or by asking a
        presidency member to add you. Every sign-up is confirmed by text, and you're subscribed only
        after you reply YES.
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
        Messages are only for quorum and Relief Society business. They are never used for political,
        commercial, or personal purposes.
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
    </Layout>
  );
}

export function PrivacyPage({ config }: { config: SiteConfig }) {
  return (
    <Layout title="Privacy">
      <h1>Privacy policy</h1>
      <p class="fine">Effective {EFFECTIVE_DATE}</p>
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
        requests. Only the quorum and Relief Society presidency members who run these texts can see
        the list.
      </p>
      <h2>Sharing</h2>
      <p>
        We do not sell, rent, or share your information. No mobile information will be shared with
        third parties or affiliates for marketing or promotional purposes. Text messaging opt-in data
        and consent are not shared with any third parties.
      </p>
      <p>
        Two service providers process your number only to run this service: Telnyx, which delivers
        the texts, and Cloudflare, which hosts this site and its data.
      </p>
      <h2>Keeping and deleting it</h2>
      <p>
        If you opt out, we stop texting you and delete your name and group memberships. We keep the
        opt-out record so we never text you again by mistake. To have everything deleted, email{" "}
        <a href={`mailto:${config.contactEmail}`}>{config.contactEmail}</a>.
      </p>
    </Layout>
  );
}
