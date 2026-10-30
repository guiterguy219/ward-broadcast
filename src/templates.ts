/**
 * Message templates: saved bodies with {{placeholders}}. The group's sender
 * prefix and the opt-out footer are added at send time, so templates leave
 * them out.
 */

export type VariableSpec = {
  required?: boolean;
  default?: string;
  description?: string;
};

export type Template = {
  slug: string;
  name: string;
  body: string;
  defaultGroups: string[];
  variables: Record<string, VariableSpec>;
  updatedAt?: string;
};

type TemplateRow = {
  slug: string;
  name: string;
  body: string;
  default_groups: string;
  variables: string;
  updated_at: string;
};

/** Values filled in automatically; templates may use these without declaring them. */
export const BUILT_IN_VARIABLES = ["sunday", "month", "signup_link"] as const;

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Ward time zone for dates like "next Sunday". */
export const TIME_ZONE = "America/Denver";

/** Placeholder names used in a body, in order of first appearance. */
export function placeholdersIn(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((match) => match[1]))];
}

/** Calendar date parts of `now` in ward time. */
function wardDate(now: Date): { year: number; month: number; day: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday),
  };
}

/**
 * The UTC instant when the current ward-time month began (midnight on the 1st
 * in America/Denver), for "first text this month" checks.
 */
export function wardMonthStartUtc(now: Date): Date {
  const { year, month } = wardDate(now);
  // Denver midnight is 06:00 or 07:00 UTC depending on DST; pick whichever lands on local midnight.
  for (const hour of [6, 7]) {
    const candidate = new Date(Date.UTC(year, month - 1, 1, hour));
    const local = wardDate(candidate);
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", hourCycle: "h23" }).format(candidate),
    );
    if (local.day === 1 && localHour === 0) return candidate;
  }
  return new Date(Date.UTC(year, month - 1, 1, 7));
}

/**
 * Built-in values for a given moment, computed on the ward-time calendar (so
 * DST changes never skip a day).
 * - sunday: the coming Sunday, e.g. "Nov 8" (today if it's Sunday)
 * - month: the current month name, e.g. "November"
 * - signup_link: the public signup page, without https://
 */
export function builtInValues(now: Date, signupLink: string): Record<string, string> {
  const today = wardDate(now);
  const sunday = new Date(Date.UTC(today.year, today.month - 1, today.day + ((7 - today.weekday) % 7)));
  const inUtc = (options: Intl.DateTimeFormatOptions, date: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(date);
  return {
    sunday: inUtc({ month: "short", day: "numeric" }, sunday),
    month: inUtc({ month: "long" }, new Date(Date.UTC(today.year, today.month - 1, 1))),
    signup_link: signupLink,
  };
}

export class TemplateError extends Error {}

/**
 * Fills a body's placeholders.
 * @param variables the template's declared variables (for defaults and required checks)
 * @param values caller-supplied values; empty strings count as missing for required variables
 * @param builtIns values from builtInValues()
 * @throws TemplateError listing every required variable without a value, or unknown values passed
 */
export function render(
  body: string,
  variables: Record<string, VariableSpec>,
  values: Record<string, string>,
  builtIns: Record<string, string>,
): string {
  const unknown = Object.keys(values).filter((name) => !(name in variables) && !(name in builtIns));
  if (unknown.length > 0) throw new TemplateError(`Unknown variable: ${unknown.join(", ")}`);

  // Built-ins can be overridden, e.g. sunday: "Nov 15" for a reminder two weeks out.
  const resolved: Record<string, string> = { ...builtIns };
  for (const name of Object.keys(builtIns)) {
    if (values[name]?.trim()) resolved[name] = values[name].trim();
  }
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(variables)) {
    const value = values[name]?.trim() || spec.default || "";
    if (!value && spec.required) missing.push(name);
    resolved[name] = value;
  }
  if (missing.length > 0) throw new TemplateError(`Missing required variable: ${missing.join(", ")}`);
  return body
    .replace(PLACEHOLDER, (_, name: string) => resolved[name] ?? "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Validates a template before saving.
 * @throws TemplateError for a bad slug, empty body, or placeholders that are neither declared nor built in
 */
export function validateTemplate(template: Template, knownGroups: string[]): void {
  if (!SLUG.test(template.slug)) throw new TemplateError("Slug must be lowercase letters, digits, and dashes.");
  if (!template.name.trim()) throw new TemplateError("Name is required.");
  if (!template.body.trim()) throw new TemplateError("Body is required.");
  const undeclared = placeholdersIn(template.body).filter(
    (name) => !(name in template.variables) && !(BUILT_IN_VARIABLES as readonly string[]).includes(name),
  );
  if (undeclared.length > 0) throw new TemplateError(`Declare these variables: ${undeclared.join(", ")}`);
  const badGroups = template.defaultGroups.filter((slug) => !knownGroups.includes(slug));
  if (badGroups.length > 0) throw new TemplateError(`Unknown group: ${badGroups.join(", ")}`);
}

function fromRow(row: TemplateRow): Template {
  return {
    slug: row.slug,
    name: row.name,
    body: row.body,
    defaultGroups: JSON.parse(row.default_groups) as string[],
    variables: JSON.parse(row.variables) as Record<string, VariableSpec>,
    updatedAt: row.updated_at,
  };
}

export async function listTemplates(db: D1Database): Promise<Template[]> {
  const { results } = await db.prepare("SELECT * FROM templates ORDER BY slug").all<TemplateRow>();
  return results.map(fromRow);
}

export async function getTemplate(db: D1Database, slug: string): Promise<Template | null> {
  const row = await db.prepare("SELECT * FROM templates WHERE slug = ?").bind(slug).first<TemplateRow>();
  return row ? fromRow(row) : null;
}

/** Creates or replaces a template (call validateTemplate first). */
export async function saveTemplate(db: D1Database, template: Template): Promise<void> {
  await db
    .prepare(
      `INSERT INTO templates (slug, name, body, default_groups, variables) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (slug) DO UPDATE SET name = ?2, body = ?3, default_groups = ?4, variables = ?5,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .bind(
      template.slug,
      template.name.trim(),
      template.body.trim(),
      JSON.stringify(template.defaultGroups),
      JSON.stringify(template.variables),
    )
    .run();
}

/** @returns true if a template was deleted */
export async function deleteTemplate(db: D1Database, slug: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM templates WHERE slug = ?").bind(slug).run();
  return result.meta.changes > 0;
}
