-- Core schema for GibsonJ Broadcast.
-- Timestamps are ISO 8601 UTC strings, e.g. 2026-10-29T18:04:05.123Z.

-- A group members can join, e.g. Elders Quorum.
CREATE TABLE groups (
  slug        TEXT PRIMARY KEY,                -- 'eq'; used in URLs and memberships
  name        TEXT NOT NULL,                   -- 'Elders Quorum'
  keyword     TEXT NOT NULL UNIQUE,            -- 'EQ'; members text JOIN EQ
  sender_name TEXT NOT NULL,                   -- prefix on every broadcast: 'Payson 10th Ward EQ'
  reply_text  TEXT NOT NULL,                   -- canned answer to non-keyword replies
  active      INTEGER NOT NULL DEFAULT 1
);

-- One row per phone number. A member is texted only while status = 'active'.
CREATE TABLE members (
  id         INTEGER PRIMARY KEY,
  phone      TEXT NOT NULL UNIQUE,             -- E.164, e.g. +18015550123
  name       TEXT,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'active', 'stopped')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Which groups a member belongs to. 'pending' until they reply YES.
CREATE TABLE memberships (
  member_id  INTEGER NOT NULL REFERENCES members (id) ON DELETE CASCADE,
  group_slug TEXT NOT NULL REFERENCES groups (slug),
  status     TEXT NOT NULL CHECK (status IN ('pending', 'active', 'left')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (member_id, group_slug)
);

-- Append-only audit trail of consent, kept even after a member is deleted.
CREATE TABLE consent_log (
  id         INTEGER PRIMARY KEY,
  phone      TEXT NOT NULL,
  action     TEXT NOT NULL CHECK (action IN
               ('join_requested', 'confirmed', 'left', 'stopped', 'started', 'invited', 'removed')),
  group_slug TEXT,                             -- null for whole-number actions like STOP
  source     TEXT NOT NULL CHECK (source IN ('web', 'sms', 'admin')),
  actor      TEXT,                             -- admin who invited/removed; null for member actions
  detail     TEXT,                             -- raw inbound text or form summary
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX consent_log_phone ON consent_log (phone, created_at);

-- Saved message bodies with {{placeholders}}; the group prefix is added at send time.
CREATE TABLE templates (
  slug           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  body           TEXT NOT NULL,
  default_groups TEXT NOT NULL DEFAULT '[]',   -- JSON array of group slugs
  variables      TEXT NOT NULL DEFAULT '{}',   -- JSON: { name: { required, default, description } }
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A rendered message an admin has reviewed; send_broadcast only accepts a fresh preview.
CREATE TABLE previews (
  id              TEXT PRIMARY KEY,            -- random, e.g. pv_7Q2...
  author          TEXT NOT NULL,
  body            TEXT NOT NULL,               -- rendered, without group prefix
  template_slug   TEXT,
  groups          TEXT NOT NULL,               -- JSON array of group slugs
  recipient_count INTEGER NOT NULL,
  segments        INTEGER NOT NULL,            -- per recipient, worst case across groups
  expires_at      TEXT NOT NULL,
  used_at         TEXT
);

-- One send to one or more groups.
CREATE TABLE broadcasts (
  id              INTEGER PRIMARY KEY,
  preview_id      TEXT UNIQUE REFERENCES previews (id),
  author          TEXT NOT NULL,
  body            TEXT NOT NULL,
  template_slug   TEXT,
  groups          TEXT NOT NULL,               -- JSON array of group slugs
  recipient_count INTEGER NOT NULL,
  segments        INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'done')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per recipient per broadcast; delivery webhooks update it by telnyx_id.
CREATE TABLE outbox (
  id           INTEGER PRIMARY KEY,
  broadcast_id INTEGER NOT NULL REFERENCES broadcasts (id),
  member_id    INTEGER REFERENCES members (id) ON DELETE SET NULL,
  phone        TEXT NOT NULL,
  text         TEXT NOT NULL,                  -- exact text sent, prefix and footer included
  status       TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'skipped')),
  telnyx_id    TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (broadcast_id, phone)
);
CREATE INDEX outbox_telnyx_id ON outbox (telnyx_id);

-- Inbound texts that weren't keywords; auto_replied drives the once-a-day loop guard.
CREATE TABLE replies (
  id           INTEGER PRIMARY KEY,
  phone        TEXT NOT NULL,
  member_id    INTEGER REFERENCES members (id) ON DELETE SET NULL,
  text         TEXT NOT NULL,
  auto_replied INTEGER NOT NULL DEFAULT 0,
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX replies_phone ON replies (phone, received_at);
