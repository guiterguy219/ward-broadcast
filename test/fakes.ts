/** Test doubles: an SMS sender that records messages, and a Telnyx webhook signer. */
import type { SendResult, SmsSender } from "../src/telnyx";

export type SentMessage = { to: string; text: string };

/** Records every send; set `failWith` to simulate Telnyx errors (e.g. 40010). */
export class FakeSender implements SmsSender {
  sent: SentMessage[] = [];
  failWith: { code: string; error: string } | null = null;
  private counter = 0;

  async send(to: string, text: string): Promise<SendResult> {
    this.sent.push({ to, text });
    if (this.failWith) return { ok: false, ...this.failWith };
    this.counter += 1;
    return { ok: true, id: `fake-${this.counter}` };
  }

  /** Texts sent to one number, oldest first. */
  to(phone: string): string[] {
    return this.sent.filter((message) => message.to === phone).map((message) => message.text);
  }
}

const toBase64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");

/** An Ed25519 key pair standing in for Telnyx's webhook signing key. */
export async function createWebhookSigner() {
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = toBase64((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);

  /** Signs `${timestamp}|${body}` the way Telnyx does and returns the headers. */
  async function sign(body: string, timestamp = Math.floor(Date.now() / 1000)) {
    const data = new TextEncoder().encode(`${timestamp}|${body}`);
    const signature = toBase64(await crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, data));
    return { "telnyx-signature-ed25519": signature, "telnyx-timestamp": String(timestamp) };
  }

  return { publicKey, sign };
}

let inboundCounter = 0;

/** A Telnyx v2 message.received event body. */
export function inboundEvent(from: string, text: string, id = `in-${++inboundCounter}`): string {
  return JSON.stringify({
    data: {
      id: `evt-${id}`,
      event_type: "message.received",
      payload: { id, text, from: { phone_number: from }, to: [{ phone_number: "+13858959493" }] },
    },
  });
}
