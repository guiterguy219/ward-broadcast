import { describe, expect, it } from "vitest";
import { builtInValues, placeholdersIn, render, TemplateError, validateTemplate } from "../src/templates";

const LINK = "broadcast.gibsonj.net/join";

describe("builtInValues", () => {
  it("uses the coming Sunday in Utah time, or today on a Sunday", () => {
    expect(builtInValues(new Date("2026-11-07T18:00:00Z"), LINK).sunday).toBe("Nov 8"); // Saturday
    expect(builtInValues(new Date("2026-11-08T18:00:00Z"), LINK).sunday).toBe("Nov 8"); // Sunday
    // 1 am UTC Sunday is still Saturday evening in Utah.
    expect(builtInValues(new Date("2026-11-08T01:00:00Z"), LINK).sunday).toBe("Nov 8");
    expect(builtInValues(new Date("2026-11-07T18:00:00Z"), LINK).month).toBe("November");
  });

  it("doesn't skip a day across the spring DST change", () => {
    // Sat Mar 13 2027, 11:30 pm MST; DST starts that night.
    expect(builtInValues(new Date("2027-03-14T06:30:00Z"), LINK).sunday).toBe("Mar 14");
  });

  it("starts the month at midnight Utah time", async () => {
    const { wardMonthStartUtc } = await import("../src/templates");
    expect(wardMonthStartUtc(new Date("2026-11-15T12:00:00Z")).toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(wardMonthStartUtc(new Date("2027-01-15T12:00:00Z")).toISOString()).toBe("2027-01-01T07:00:00.000Z");
    // 7 pm Oct 31 in Utah is already Nov 1 in UTC, but still October in the ward.
    expect(wardMonthStartUtc(new Date("2026-11-01T01:00:00Z")).toISOString()).toBe("2026-10-01T06:00:00.000Z");
  });
});

describe("render", () => {
  it("fills values and defaults, and collapses gaps left by empty optionals", () => {
    const body = "Activity {{what}} on {{date}}. {{extra}} See {{signup_link}}";
    const out = render(
      body,
      { what: { required: true }, date: { default: "Thursday" }, extra: {} },
      { what: "Soup night" },
      { signup_link: LINK },
    );
    expect(out).toBe(`Activity Soup night on Thursday. See ${LINK}`);
  });

  it("lets a caller override a built-in, e.g. a reminder two weeks out", () => {
    expect(render("Lesson {{sunday}}", {}, { sunday: "Nov 15" }, { sunday: "Nov 8" })).toBe("Lesson Nov 15");
  });

  it("rejects values the template doesn't declare", () => {
    expect(() => render("Hi {{name}}", { name: {} }, { nmae: "x" }, {})).toThrow(
      new TemplateError("Unknown variable: nmae"),
    );
  });
});

describe("validateTemplate", () => {
  const base = {
    slug: "help-needed",
    name: "Help needed",
    body: "{{who}} needs help {{when}}.",
    defaultGroups: ["eq"],
  };
  it("requires every placeholder to be declared or built in", () => {
    expect(placeholdersIn(base.body)).toEqual(["who", "when"]);
    expect(() => validateTemplate({ ...base, variables: { who: {} } }, ["eq", "rs"])).toThrow(
      "Declare these variables: when",
    );
    expect(() => validateTemplate({ ...base, variables: { who: {}, when: {} } }, ["eq", "rs"])).not.toThrow();
  });

  it("checks slug format and default groups", () => {
    expect(() => validateTemplate({ ...base, slug: "Help Needed", variables: { who: {}, when: {} } }, ["eq"])).toThrow(
      "Slug",
    );
    expect(() =>
      validateTemplate({ ...base, defaultGroups: ["choir"], variables: { who: {}, when: {} } }, ["eq"]),
    ).toThrow("Unknown group: choir");
  });
});
