-- Telnyx can deliver the same webhook more than once; remember which inbound
-- messages were handled so a retry never sends a second reply.
CREATE TABLE inbound_events (
  telnyx_id   TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
