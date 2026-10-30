-- Failed admin passphrase attempts, for a per-IP hourly limit on the sign-in page.
CREATE TABLE auth_failures (
  id        INTEGER PRIMARY KEY,
  ip        TEXT NOT NULL,
  failed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX auth_failures_ip ON auth_failures (ip, failed_at);
