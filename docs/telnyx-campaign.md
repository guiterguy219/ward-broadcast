# Telnyx messaging setup

Source of truth for what is (and should be) configured in the Telnyx portal. Update this file whenever the portal changes.

Last reviewed: 2026-10-29.

## Current state

| Item | Value | Status |
| --- | --- | --- |
| Account level | Paid | Done |
| Phone number | +1 (385) 895-9493, local Payson number | Active |
| Messaging profile | "GibsonJ Broadcast - Payson 10th Ward" | Number assigned |
| Inbound webhook | `https://broadcast.gibsonj.net/api/webhook` | Set; verified with the Ed25519 public key |
| Failover webhook | none | Not set |
| 10DLC brand (sole proprietor) | — | Not registered |
| 10DLC campaign | — | Not submitted |
| API key | Infisical `finn-integration` → `GIBSONJ_PERSONAL_TELNYX_API_KEY` | Created |

Until the campaign is approved and the number is attached to it, texts to anyone else's phone will be blocked.

## App configuration

| Setting | Where | Value |
| --- | --- | --- |
| Webhook API version | Messaging profile | v2 (signed with Ed25519; v1 is unsigned and will be rejected) |
| Webhook public key | `TELNYX_PUBLIC_KEY` var in `wrangler.jsonc` | From portal > Account Settings > Keys & Credentials > Public Key. Set 2026-10-29. |
| API key | Worker secret `TELNYX_API_KEY` | Same value as Infisical `GIBSONJ_PERSONAL_TELNYX_API_KEY` |
| Keyword replies | `KEYWORD_REPLIES` var | `app`: the Worker answers STOP/START/HELP with the texts below. If the messaging profile's own keyword auto-responses get turned on, set this to `telnyx` so members don't get two replies. |

## Pending changes (not applied in Telnyx yet)

The site was rebranded to **GibsonJ Broadcast** on 2026-10-29. When the brand and campaign are registered, use the GibsonJ Broadcast wording below. If an earlier campaign was already submitted with "Payson 10th Ward" wording, let it finish review and update the auto-response texts afterward; resubmitting costs another $15 vetting fee.

## Brand (10DLC sole proprietor)

| Field | Value | Notes |
| --- | --- | --- |
| Entity type | Sole proprietor | No EIN. Don't use Gibson Ops LLC's EIN; this isn't Gibson Ops business. |
| Legal name | Jared Gibson | Must match government ID |
| Display / brand name | GibsonJ Broadcast | Telnyx rejects sole-prop names or websites containing words like "Church", "LLC", "Bank", "Media" |
| Website | https://broadcast.gibsonj.net | |
| Email | Personal email (not on this public repo) | Free providers are allowed |
| Mobile for verification PIN | Jared's personal cell (not on this public repo) | Telnyx texts a PIN; email it back to 10dlcquestions@telnyx.com within 24 hours |
| Address | Home address, no PO box | |
| Vertical | Closest non-commercial option offered | |

Cost: about $4.50 one-time.

## Campaign

| Field | Value |
| --- | --- |
| Use case | Sole Proprietor |
| Description | Jared Gibson sends opt-in announcements (lesson reminders, service requests, activity news) to members of two volunteer groups he helps lead in his local congregation. About 2 messages a week per group. |
| Message flow / opt-in | Members opt in three ways, all confirmed by text: (1) web form at https://broadcast.gibsonj.net/join with an unchecked consent checkbox and full disclosures; (2) texting JOIN EQ or JOIN RS to the number; (3) asking a group leader in person, who triggers a confirmation text. In every case the member is subscribed only after replying YES. Consent is logged with source and timestamp. |
| Privacy policy | https://broadcast.gibsonj.net/privacy |
| Terms | https://broadcast.gibsonj.net/terms |
| Embedded links | Yes, only to broadcast.gibsonj.net; no public URL shorteners |
| Embedded phone numbers | No |
| Age-gated, lending, affiliate marketing | No |
| Number pool | No (1 number) |

Cost: $15 per review submission, then $2/month (first 3 months billed up front). Review takes 2–3 business days; then attach +1 (385) 895-9493 to the campaign.

Describe it as Jared sending his own announcements. Don't describe it as a service that sends for other organizations; that reads as a platform/ISV, which a sole-proprietor registration doesn't cover.

### Keywords

| Type | Keywords |
| --- | --- |
| Opt-in | START, JOIN |
| Opt-out | STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT |
| Help | HELP, INFO |

### Auto-response texts

All are GSM-7 (no curly quotes or emoji) and fit in one 160-character segment.

| Text | Chars | Wording |
| --- | --- | --- |
| Opt-in confirmation | 148 | GibsonJ Broadcast: You're signed up for Payson 10th Ward EQ texts, about 2 a week. Msg & data rates may apply. Reply HELP for help, STOP to opt out. |
| Opt-out confirmation | 87 | GibsonJ Broadcast: You're unsubscribed and won't get more texts. Reply START to rejoin. |
| Help | 141 | GibsonJ Broadcast is Jared Gibson's text service for the Payson 10th Ward EQ and RS. Questions: broadcast@gibsonj.net. Reply STOP to opt out. |

If Telnyx's built-in keyword auto-replies are enabled, the app must only record opt-in/opt-out state and not send its own reply, or members get two texts.

### Sample messages

Every broadcast starts with the group's sender name and, when it fits, ends with the opt-out line.

1. Payson 10th Ward EQ: This Sunday's lesson is on ministering. Please read ahead in the latest general conference talks if you can. Reply STOP to opt out. (152 chars)
2. Payson 10th Ward EQ: A ward family is moving Saturday at 9 am and could use 4 more people to help load. Reply STOP to opt out. (126 chars)
3. Payson 10th Ward RS: Soup and service night is Thursday at 7 pm at the meetinghouse. Bring a friend! Reply STOP to opt out. (123 chars)

## Before going live

- Bishop approval (General Handbook 38.8.21.2) and a second admin.
- Set `SIGNUPS_OPEN` to `"true"` in `wrangler.jsonc` once texting is built and the campaign is approved.
- Add a Cloudflare Turnstile check to `/join` before opening it; per-number and global confirmation-text limits are already in place.
