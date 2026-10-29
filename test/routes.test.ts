import { describe, expect, it } from "vitest";
import app, { type Env } from "../src/index";
import { toE164 } from "../src/content";

const env: Env = { SIGNUPS_OPEN: "false", TEXT_NUMBER: "+18015550100", CONTACT_EMAIL: "test@example.com" };

/** Posts the signup form as a browser would. */
function postJoin(fields: [string, string][], overrides: Partial<Env> = {}) {
  const body = new URLSearchParams(fields);
  return app.request(
    "/join",
    { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } },
    { ...env, ...overrides },
  );
}

describe("pages", () => {
  it.each(["/", "/join", "/terms", "/privacy"])("%s renders with the not-official disclaimer", async (path) => {
    const res = await app.request(path, {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("not an official website or product");
  });

  it("join page shows required SMS disclosures and an unchecked consent box", async () => {
    const html = await (await app.request("/join", {}, env)).text();
    expect(html).toContain("Message and data rates may apply.");
    expect(html).toContain("Reply HELP for help or STOP to opt out");
    expect(html).toMatch(/name="consent" value="yes"(?! checked)/);
  });

  it("shows text-to-join only when a number is configured", async () => {
    expect(await (await app.request("/", {}, env)).text()).toContain("(801) 555-0100");
    expect(await (await app.request("/", {}, { ...env, TEXT_NUMBER: "" })).text()).not.toContain("JOIN EQ");
  });
});

describe("POST /join", () => {
  it("rejects a form without consent, a valid phone, or a group", async () => {
    const res = await postJoin([["name", "Test Member"], ["phone", "123"]]);
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("Enter a 10-digit US mobile number");
    expect(html).toContain("3 things need fixing");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("Choose at least one group.");
    expect(html).toContain("Check the box to agree");
  });

  it("acknowledges a valid form without saving while signups are closed", async () => {
    const res = await postJoin([
      ["name", "Test Member"],
      ["phone", "801-555-0123"],
      ["groups", "eq"],
      ["groups", "rs"],
      ["consent", "yes"],
    ]);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("nothing was saved");
  });
});

describe("POST /api/webhook", () => {
  it("acknowledges Telnyx events", async () => {
    const res = await app.request(
      "/api/webhook",
      { method: "POST", body: JSON.stringify({ data: { event_type: "message.received" } }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });
});

describe("toE164", () => {
  it.each([
    ["801-555-0123", "+18015550123"],
    ["+1 (801) 555 0123", "+18015550123"],
    ["123-456-7890", null],
    ["555-0123", null],
  ])("%s → %s", (input, expected) => {
    expect(toE164(input)).toBe(expected);
  });
});
