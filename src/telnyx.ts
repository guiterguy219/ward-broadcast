/**
 * Telnyx integration: outbound SMS and inbound webhook verification.
 * Uses only fetch and WebCrypto, so it runs the same in Workers and Node tests.
 */

export type SendResult = { ok: true; id: string } | { ok: false; error: string; code?: string };

/** Anything that can send one SMS; tests use a fake. */
export interface SmsSender {
  send(to: string, text: string): Promise<SendResult>;
}

const TELNYX_API = "https://api.telnyx.com/v2";

/**
 * Sender backed by the Telnyx Messages API.
 * @param apiKey Telnyx API v2 key
 * @param from E.164 number to send from
 */
export function telnyxSender(apiKey: string, from: string): SmsSender {
  return {
    async send(to, text) {
      let response: Response;
      try {
        response = await fetch(`${TELNYX_API}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from, to, text }),
        });
      } catch (error) {
        return { ok: false, error: `network: ${(error as Error).message}` };
      }
      const body = (await response.json().catch(() => null)) as TelnyxResponse | null;
      if (response.ok && body?.data?.id) return { ok: true, id: body.data.id };
      const first = body?.errors?.[0];
      return {
        ok: false,
        code: first?.code,
        error: first ? `${first.title ?? "error"}: ${first.detail ?? ""}`.trim() : `HTTP ${response.status}`,
      };
    },
  };
}

type TelnyxResponse = {
  data?: { id?: string };
  errors?: { code?: string; title?: string; detail?: string }[];
};

/** Signed webhooks older or newer than this are rejected (replay protection). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies a Telnyx v2 webhook: an Ed25519 signature over `${timestamp}|${rawBody}`.
 * Fails closed when the public key or headers are missing.
 * @param publicKey base64 Ed25519 public key from the Telnyx portal
 * @param signature value of the telnyx-signature-ed25519 header (base64)
 * @param timestamp value of the telnyx-timestamp header (Unix seconds)
 * @param rawBody the exact request body bytes as text
 * @param nowSeconds current Unix time in seconds (injectable for tests)
 */
export async function verifyTelnyxSignature(input: {
  publicKey: string | undefined;
  signature: string | undefined;
  timestamp: string | undefined;
  rawBody: string;
  nowSeconds?: number;
}): Promise<boolean> {
  const { publicKey, signature, timestamp, rawBody } = input;
  if (!publicKey || !signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  try {
    const key = await crypto.subtle.importKey("raw", base64ToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    const message = new TextEncoder().encode(`${timestamp}|${rawBody}`);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, base64ToBytes(signature), message);
  } catch {
    return false;
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.trim());
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The parts of a Telnyx v2 webhook this app reads. */
export type TelnyxEvent = {
  data?: {
    id?: string;
    event_type?: string;
    payload?: {
      id?: string;
      text?: string;
      from?: { phone_number?: string };
      to?: { phone_number?: string; status?: string }[];
      errors?: { code?: string; title?: string; detail?: string }[];
    };
  };
};
