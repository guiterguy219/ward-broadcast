/**
 * OAuth sign-in for the MCP endpoint. The consent page doubles as the login:
 * an admin types their passphrase and approves the client in one step.
 *
 * Passphrases are long random strings generated for each admin, so a plain
 * SHA-256 is enough (there's nothing to brute-force) and it stays well inside
 * the Workers free plan's CPU limit. Only the hashes live in config.
 */
import type { ConsentDescription, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Context } from "hono";
import { Layout } from "./pages/Layout";

/** Scope granted to every admin token. */
export const ADMIN_SCOPE = "broadcast";

/** What a token carries into MCP tool calls. */
export type AdminProps = { admin: string };

type AuthEnv = { ADMIN_KEYS?: string; OAUTH_PROVIDER: OAuthHelpers };

/**
 * Finds the admin whose passphrase hash matches, comparing every entry in
 * constant time.
 * @param adminKeys JSON object of admin name → lowercase hex SHA-256 of their passphrase
 * @returns the admin name, or null
 */
export async function adminForPassphrase(adminKeys: string | undefined, passphrase: string): Promise<string | null> {
  if (!adminKeys || !passphrase) return null;
  let entries: [string, string][];
  try {
    entries = Object.entries(JSON.parse(adminKeys) as Record<string, string>);
  } catch {
    return null;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(passphrase.trim())));
  let match: string | null = null;
  for (const [name, hex] of entries) {
    const expected = hexToBytes(hex);
    let diff = expected.length ^ digest.length;
    for (let index = 0; index < digest.length; index += 1) diff |= digest[index] ^ (expected[index] ?? 0);
    if (diff === 0) match = name;
  }
  return match;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = /^[0-9a-f]+$/i.test(hex) ? hex : "";
  return Uint8Array.from(clean.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

function ConsentPage({ details, handle, error }: { details: ConsentDescription; handle: string; error?: string }) {
  const origin = details.clientDomain
    ? `published by ${details.clientDomain}`
    : "self-registered; its name isn't verified";
  return (
    <Layout title="Connect an app">
      <h1>Connect {details.clientName} to GibsonJ Broadcast?</h1>
      <p class="lead">
        This lets {details.clientName} ({origin}) list members, manage templates, and send broadcasts as you. Access
        goes to <strong>{details.redirectHost}</strong>.
      </p>
      {details.redirectIsLoopback && (
        <div class="notice notice-info">
          <p>
            <strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting
            from it.
          </p>
        </div>
      )}
      <form method="post" action="/authorize" class="panel">
        {error && (
          <div class="notice notice-error" role="alert">
            <p>{error}</p>
          </div>
        )}
        <input type="hidden" name="handle" value={handle} />
        <div class="field">
          <label class="label" for="passphrase">
            Admin passphrase
          </label>
          <input
            class="input"
            type="password"
            id="passphrase"
            name="passphrase"
            autocomplete="current-password"
            required
          />
        </div>
        <div class="actions">
          <button class="button" name="decision" value="approve">
            Allow
          </button>
          <button class="button" name="decision" value="deny" style="background: transparent; color: var(--ink)">
            Deny
          </button>
        </div>
      </form>
    </Layout>
  );
}

/** GET /authorize: validate the client's request and show the consent + passphrase page. */
export async function showAuthorize(c: Context<{ Bindings: AuthEnv }>) {
  const oauth = c.env.OAUTH_PROVIDER;
  let request;
  try {
    request = await oauth.parseAuthRequest(c.req.raw);
  } catch (error) {
    const redirect = (error as { redirectTo?: string }).redirectTo;
    if (redirect) return c.redirect(redirect, 302);
    return c.text(`This sign-in link isn't valid: ${(error as Error).message}`, 400);
  }
  const details = await oauth.describeConsent(request);
  const consent = await oauth.beginConsent(request);
  const html = await (<ConsentPage details={details} handle={consent.handle} />).toString();
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(`<!doctype html>${html}`, { headers: consent.headers });
}

/** POST /authorize: deny, or check the passphrase and issue a token for that admin. */
export async function submitAuthorize(c: Context<{ Bindings: AuthEnv }>) {
  const oauth = c.env.OAUTH_PROVIDER;
  const form = await c.req.formData();
  const handle = String(form.get("handle") ?? "");
  try {
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const admin = await adminForPassphrase(c.env.ADMIN_KEYS, String(form.get("passphrase") ?? ""));
    if (!admin) {
      // The handle is still valid; send them back to the same page to retry.
      return c.html(
        <Layout title="Wrong passphrase">
          <h1>That passphrase didn't match</h1>
          <p>
            Use your browser's Back button and try again. If it has been more than 10 minutes, start connecting again
            from your app.
          </p>
        </Layout>,
        401,
      );
    }
    const approved = await oauth.approveConsent(c.req.raw, handle, { scope: [ADMIN_SCOPE] });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: admin,
      metadata: { admin },
      scope: [ADMIN_SCOPE],
      props: { admin } satisfies AdminProps,
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch {
    return c.text("This sign-in page expired or was already used. Start connecting again from your app.", 400);
  }
}
