# ward-broadcast

Opt-in SMS announcements for the Payson 10th Ward Elders Quorum and Relief Society.
Cloudflare Worker (Hono) at https://broadcast.gibsonj.net.

Design and decisions: the "Church SMS Broadcast — Research & Proposal" Claude Doc.

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

Merging to `main` deploys automatically: `.github/workflows/ci.yml` runs typecheck +
tests on every PR and push, then `wrangler deploy` on `main` using the repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Config (`wrangler.jsonc` vars)

| Var | Meaning |
| --- | --- |
| `SIGNUPS_OPEN` | `"true"` once the campaign is approved and the bishop has signed off |
| `TEXT_NUMBER` | Telnyx number in E.164; empty hides the "text JOIN" line |
| `CONTACT_EMAIL` | Shown on every page and in HELP replies |
