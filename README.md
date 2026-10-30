# ward-broadcast

[![CI](https://github.com/guiterguy219/ward-broadcast/actions/workflows/ci.yml/badge.svg)](https://github.com/guiterguy219/ward-broadcast/actions/workflows/ci.yml)

Opt-in SMS announcements for the Payson 10th Ward Elders Quorum and Relief Society.
Cloudflare Worker (Hono) at https://broadcast.gibsonj.net.

Design and decisions: the "Church SMS Broadcast — Research & Proposal" Claude Doc.
Telnyx brand/campaign configuration: [docs/telnyx-campaign.md](docs/telnyx-campaign.md).

## Status

- Public pages: `/`, `/join`, `/terms`, `/privacy` (needed for Telnyx 10DLC review).
- `POST /join` validates only; nothing is stored while `SIGNUPS_OPEN` is `"false"`.
- `POST /api/webhook` acknowledges Telnyx events and logs the event type only.

## Commands

```bash
npm test            # route tests via app.request (no server)
npm run typecheck
npm run deploy      # manual deploy; needs access to the gibsonj.net zone
```

`main` is protected: changes land through a PR with passing CI. Merging deploys automatically: `.github/workflows/ci.yml` runs typecheck +
tests on every PR and push, then `wrangler deploy` on `main` using the repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Config (`wrangler.jsonc` vars)

| Var | Meaning |
| --- | --- |
| `SIGNUPS_OPEN` | `"true"` once the campaign is approved and the bishop has signed off |
| `TEXT_NUMBER` | Telnyx number in E.164; empty hides the "text JOIN" line |
| `CONTACT_EMAIL` | Shown on every page and in HELP replies |

## Database

D1 (`ward-broadcast`), schema in `migrations/`. CI applies pending migrations, then deploys.
Keep migrations additive (new tables, columns, indexes) so the running Worker never breaks
if a deploy fails after the schema changes. Apply locally with
`npx wrangler d1 migrations apply ward-broadcast --remote`.

## Connect Claude (admin)

The admin interface is the MCP server at `https://broadcast.gibsonj.net/mcp`. Sign-in is OAuth; the
consent page asks for your admin passphrase (only its SHA-256 lives in `ADMIN_KEYS`).

- **claude.ai / Claude desktop / mobile:** Settings → Connectors → Add custom connector → URL
  `https://broadcast.gibsonj.net/mcp` → Connect → enter the passphrase → Allow.
- **Claude Code:** `claude mcp add --transport http gibsonj-broadcast https://broadcast.gibsonj.net/mcp`,
  then run `/mcp` and authenticate.

Then ask in plain words, e.g. "Preview the lesson reminder for EQ, topic Behold the Man." Claude previews
first (exact text, recipients, segments, cost) and only sends after you approve.

Tools: `list_groups`, `list_members`, `invite_member`, `remove_member`, `list_templates`, `save_template`,
`delete_template`, `preview_broadcast`, `send_broadcast`, `broadcast_status`, `list_broadcasts`,
`list_replies`, `usage`. Starter templates: `lesson-reminder`, `help-needed`, `activity`,
`ministering-interviews`.

### Adding an admin

Generate a long random passphrase (~25+ random characters), add
`"name": "<sha256 hex of it>"` to `ADMIN_KEYS` in `wrangler.jsonc`, and merge. Hand the passphrase over
privately. Wrong passphrases are limited to 10 per IP per hour.

## Member flow (SMS)

| Text | Effect |
| --- | --- |
| `JOIN EQ` / `JOIN RS` | Asks them to reply YES |
| `YES` | Activates pending groups, sends the opt-in confirmation |
| `LEAVE EQ` | Leaves one group |
| `STOP` / `START` | Stops everything / turns it back on |
| `HELP` | Contact info |
| anything else | The group's canned reply, at most once a day; stored for `list_replies` |
