-- Telnyx can deliver the same webhook more than once; remember which inbound
-- messages were handled so a retry never sends a second reply.
CREATE TABLE inbound_events (
  telnyx_id   TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Confirmation texts triggered by the public web form, for rate limiting.
CREATE TABLE web_confirmations (
  id      INTEGER PRIMARY KEY,
  phone   TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX web_confirmations_sent ON web_confirmations (sent_at);
