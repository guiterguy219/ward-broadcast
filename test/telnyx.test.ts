import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGNATURE_TOLERANCE_SECONDS, telnyxSender, verifyTelnyxSignature } from "../src/telnyx";
import { createWebhookSigner } from "./fakes";

describe("verifyTelnyxSignature", () => {
  it("accepts a valid signature and rejects a tampered body", async () => {
    const signer = await createWebhookSigner();
    const body = '{"data":{"event_type":"message.received"}}';
    const headers = await signer.sign(body);
    const input = {
      publicKey: signer.publicKey,
      signature: headers["telnyx-signature-ed25519"],
      timestamp: headers["telnyx-timestamp"],
    };
    expect(await verifyTelnyxSignature({ ...input, rawBody: body })).toBe(true);
    expect(await verifyTelnyxSignature({ ...input, rawBody: body.replace("received", "sent") })).toBe(false);
  });

  it("rejects stale timestamps, another key, and missing inputs", async () => {
    const signer = await createWebhookSigner();
    const other = await createWebhookSigner();
    const body = "{}";
    const old = Math.floor(Date.now() / 1000) - SIGNATURE_TOLERANCE_SECONDS - 5;
    const stale = await signer.sign(body, old);
    const fresh = await signer.sign(body);

    const check = (publicKey: string | undefined, headers: Record<string, string>) =>
      verifyTelnyxSignature({
        publicKey,
        signature: headers["telnyx-signature-ed25519"],
        timestamp: headers["telnyx-timestamp"],
        rawBody: body,
      });
    expect(await check(signer.publicKey, stale)).toBe(false);
    expect(await check(other.publicKey, fresh)).toBe(false);
    expect(await check(undefined, fresh)).toBe(false);
    expect(await check(signer.publicKey, {})).toBe(false);
    expect(await check("not base64!", fresh)).toBe(false);
  });
});

describe("telnyxSender", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to the Messages API and returns the message id", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: { id: "msg-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await telnyxSender("KEY", "+13858959493").send("+18015550123", "hello");
    expect(result).toEqual({ ok: true, id: "msg-1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telnyx.com/v2/messages");
    expect(init.headers).toMatchObject({ Authorization: "Bearer KEY" });
    expect(JSON.parse(String(init.body))).toEqual({ from: "+13858959493", to: "+18015550123", text: "hello" });
  });

  it("returns the Telnyx error code on failure (e.g. unregistered 10DLC)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ errors: [{ code: "40010", title: "Not 10DLC registered", detail: "..." }] }, { status: 400 }),
      ),
    );
    const result = await telnyxSender("KEY", "+13858959493").send("+18015550123", "hello");
    expect(result).toMatchObject({ ok: false, code: "40010" });
  });
});
