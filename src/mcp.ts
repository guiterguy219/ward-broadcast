/**
 * MCP server: the admin interface. Every tool runs as the signed-in admin
 * (from the OAuth token's props); sending always takes a preview first.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { z } from "zod";
import {
  BroadcastError,
  broadcastStatus,
  listBroadcasts,
  previewBroadcast,
  sendBroadcast,
  usageSince,
  type SendJob,
} from "./broadcasts";
import { toE164 } from "./content";
import {
  activeCountsByGroup,
  listActiveGroups,
  listMembers,
  listReplies,
  removeMember,
  requestSignup,
  UnknownGroupError,
} from "./db";
import { confirmRequest, type ProgramConfig } from "./messages";
import type { SmsSender } from "./telnyx";
import {
  deleteTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
  TemplateError,
  validateTemplate,
  wardMonthStartUtc,
  type VariableSpec,
} from "./templates";

export type McpDeps = {
  db: D1Database;
  queue: Queue<SendJob>;
  sender: SmsSender;
  program: ProgramConfig;
  /** Public signup URL without https://, for {{signup_link}}. */
  signupLink: string;
  /** Signed-in admin; recorded as author/actor everywhere. */
  admin: string;
};

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** Runs a tool body, turning expected errors into readable tool errors. */
async function guarded(body: () => Promise<ReturnType<typeof json>>) {
  try {
    return await body();
  } catch (error) {
    if (error instanceof BroadcastError || error instanceof TemplateError || error instanceof UnknownGroupError) {
      return failure(error.message);
    }
    throw error;
  }
}

const variableSpec = z.object({
  required: z.boolean().optional().describe("Fail the preview if no value is given"),
  default: z.string().optional().describe("Used when no value is given"),
  description: z.string().optional(),
});

/** Builds the MCP server with every admin tool registered. */
export function buildMcpServer(deps: McpDeps): McpServer {
  const { db, admin } = deps;
  const server = new McpServer(
    { name: "gibsonj-broadcast", version: "1.0.0" },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      instructions:
        "GibsonJ Broadcast sends opt-in announcement texts to ward groups (EQ, RS). To send: call preview_broadcast, " +
        "show the admin the sample text, recipient count, segments, and cost, and call send_broadcast with the " +
        "preview_id only after they explicitly approve. Every text gets the group prefix and opt-out footer " +
        "automatically; never add them to a body or template. Keep messages under 1 segment when possible; " +
        "avoid emoji (they triple the cost).",
    },
  );

  server.registerTool(
    "list_groups",
    { description: "Groups members can join, with active member counts and their canned reply text." },
    async () => {
      const [groups, counts] = await Promise.all([listActiveGroups(db), activeCountsByGroup(db)]);
      return json(
        groups.map((group) => ({
          slug: group.slug,
          name: group.name,
          keyword: group.keyword,
          senderName: group.sender_name,
          replyText: group.reply_text,
          activeMembers: counts[group.slug] ?? 0,
        })),
      );
    },
  );

  server.registerTool(
    "list_members",
    {
      description:
        "Members and their groups. Status: active (receiving), pending (hasn't replied YES), stopped (texted STOP).",
      inputSchema: { group: z.string().optional().describe("Group slug, e.g. eq") },
    },
    async ({ group }) => json(await listMembers(db, group)),
  );

  server.registerTool(
    "invite_member",
    {
      description:
        "Add someone who asked in person. Records their verbal consent and texts them a reply-YES confirmation; " +
        "they receive nothing else until they reply YES. Never use this for someone who hasn't asked. " +
        "A number that texted STOP can't be re-added; they must text START.",
      inputSchema: {
        phone: z.string().describe("US mobile number, any format"),
        name: z.string().optional(),
        groups: z.array(z.string()).min(1).describe('Group slugs, e.g. ["eq"]'),
        note: z.string().describe("How they asked, e.g. 'asked me after class on Nov 8'"),
      },
    },
    async ({ phone, name, groups, note }) =>
      guarded(async () => {
        const e164 = toE164(phone);
        if (!e164) return failure("That isn't a valid 10-digit US phone number.");
        const result = await requestSignup(db, {
          phone: e164,
          name,
          groups,
          source: "admin",
          actor: admin,
          detail: note,
        });
        if (result.stopped) return failure("That number texted STOP. They need to text START themselves.");
        if (result.pendingGroups.length === 0) return json({ status: "already active", groups: result.alreadyActive });
        const all = await listActiveGroups(db);
        const pending = all.filter((group) => result.pendingGroups.includes(group.slug));
        const sent = await deps.sender.send(e164, confirmRequest(deps.program, pending));
        return json({
          status: "pending",
          pendingGroups: result.pendingGroups,
          confirmationText: sent.ok ? "sent" : `failed: ${[sent.code, sent.error].filter(Boolean).join(" ")}`,
        });
      }),
  );

  server.registerTool(
    "remove_member",
    {
      description: "Remove someone from groups at their request (logged). Doesn't block them from rejoining.",
      inputSchema: {
        phone: z.string(),
        groups: z.array(z.string()).min(1).optional().describe("Group slugs; omit to remove from all groups"),
        reason: z.string().describe("Why, e.g. 'moved out of the ward'"),
      },
    },
    async ({ phone, groups, reason }) => {
      const e164 = toE164(phone);
      if (!e164) return failure("That isn't a valid 10-digit US phone number.");
      const removed = await removeMember(db, { phone: e164, groups, actor: admin, reason });
      return json({ removedFrom: removed });
    },
  );

  server.registerTool(
    "list_templates",
    { description: "Saved message templates with their variables and default groups." },
    async () => json(await listTemplates(db)),
  );

  server.registerTool(
    "save_template",
    {
      description:
        "Create or replace a template. Use {{name}} placeholders; declare each in `variables` unless it's a built-in " +
        "(sunday = coming Sunday like 'Nov 8', month, signup_link). Leave out the group prefix and 'Reply STOP' footer; " +
        "they're added automatically.",
      inputSchema: {
        slug: z.string().describe("lowercase-with-dashes, e.g. lesson-reminder"),
        name: z.string(),
        body: z.string(),
        defaultGroups: z.array(z.string()).optional().describe("Omit to keep the existing template's groups"),
        variables: z.record(z.string(), variableSpec).optional().describe("Omit to keep the existing variables"),
      },
    },
    async (input) =>
      guarded(async () => {
        // Partial edits keep whatever the caller didn't send.
        const existing = await getTemplate(db, input.slug);
        const template = {
          slug: input.slug,
          name: input.name,
          body: input.body,
          defaultGroups: input.defaultGroups ?? existing?.defaultGroups ?? [],
          variables: (input.variables ?? existing?.variables ?? {}) as Record<string, VariableSpec>,
        };
        validateTemplate(
          template,
          (await listActiveGroups(db)).map((group) => group.slug),
        );
        await saveTemplate(db, template);
        return json(await getTemplate(db, input.slug));
      }),
  );

  server.registerTool(
    "delete_template",
    { description: "Delete a template.", inputSchema: { slug: z.string() } },
    async ({ slug }) => json({ deleted: await deleteTemplate(db, slug) }),
  );

  server.registerTool(
    "preview_broadcast",
    {
      description:
        "Render a broadcast from a template (with values) or a free-text body, without sending. Returns the exact " +
        "sample text per group, recipient count, segments, estimated cost, and a preview_id valid for 15 minutes. " +
        "Show the samples to the admin before sending.",
      inputSchema: {
        template: z.string().optional().describe("Template slug"),
        values: z.record(z.string(), z.string()).optional().describe("Template variable values"),
        body: z.string().optional().describe("Free-text message instead of a template"),
        groups: z.array(z.string()).optional().describe("Group slugs; defaults to the template's default groups"),
      },
    },
    async ({ template, values, body, groups }) =>
      guarded(async () =>
        json(
          await previewBroadcast(db, { author: admin, templateSlug: template, values, body, groups }, deps.signupLink),
        ),
      ),
  );

  server.registerTool(
    "send_broadcast",
    {
      description:
        "Send a previewed broadcast. Only call this after the admin has seen the preview and explicitly said to send it.",
      inputSchema: { preview_id: z.string() },
    },
    async ({ preview_id }) =>
      guarded(async () => json(await sendBroadcast(db, deps.queue, { previewId: preview_id, author: admin }))),
  );

  server.registerTool(
    "broadcast_status",
    {
      description: "Delivery counts for one broadcast (queued, sent, delivered, failed, skipped).",
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => {
      const status = await broadcastStatus(db, id);
      return status ? json(status) : failure(`No broadcast ${id}.`);
    },
  );

  server.registerTool(
    "list_broadcasts",
    {
      description: "Recent broadcasts, newest first, with delivery counts.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
    },
    async ({ limit }) => json(await listBroadcasts(db, limit)),
  );

  server.registerTool(
    "list_replies",
    {
      description: "Recent texts from members that weren't keywords (they already got the group's canned reply).",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    },
    async ({ limit }) => json(await listReplies(db, limit)),
  );

  server.registerTool(
    "usage",
    { description: "Broadcast texts and segments sent this month (Utah time) with an estimated cost." },
    async () => json(await usageSince(db, wardMonthStartUtc(new Date()))),
  );

  return server;
}

/**
 * Handles one MCP HTTP request statelessly: a fresh server and transport per
 * request, JSON responses, no sessions to store.
 */
export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  const server = buildMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
