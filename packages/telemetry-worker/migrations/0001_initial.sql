-- Telemetry store. Every row carries the install_id so a deletion request can remove an install
-- completely; no table holds an IP address. Times are ISO-8601 UTC strings, days are YYYY-MM-DD.

-- One row per install: the latest envelope seen.
CREATE TABLE installs (
  install_id   TEXT PRIMARY KEY,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  version      TEXT NOT NULL,
  channel      TEXT NOT NULL,
  install_form TEXT NOT NULL,
  os           TEXT NOT NULL,
  os_release   TEXT NOT NULL,
  arch         TEXT NOT NULL,
  node_major   INTEGER,
  ui_lang      TEXT NOT NULL,
  country      TEXT
);

-- One row per install per UTC receive day: the activity record behind the active-install
-- counts, and the counter the per-install daily event cap is enforced against.
CREATE TABLE install_days (
  install_id   TEXT NOT NULL,
  day          TEXT NOT NULL,
  events       INTEGER NOT NULL,
  version      TEXT NOT NULL,
  channel      TEXT NOT NULL,
  install_form TEXT NOT NULL,
  os           TEXT NOT NULL,
  country      TEXT,
  PRIMARY KEY (install_id, day)
);
CREATE INDEX install_days_day ON install_days (day);

-- Crashes per install and group; the dashboard sums them per (component, group_key, version).
-- The sample columns hold the latest redacted occurrence.
CREATE TABLE crashes (
  install_id  TEXT NOT NULL,
  component   TEXT NOT NULL,
  group_key   TEXT NOT NULL,
  version     TEXT NOT NULL,
  channel     TEXT NOT NULL,
  count       INTEGER NOT NULL,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  error_name  TEXT NOT NULL,
  message     TEXT NOT NULL,
  stack       TEXT NOT NULL,
  route       TEXT,
  build_stamp TEXT,
  client      TEXT,
  uptime_s    REAL,
  exit_code   INTEGER,
  exit_signal TEXT,
  backoff_ms  INTEGER,
  PRIMARY KEY (install_id, component, group_key, version)
);
CREATE INDEX crashes_last_seen ON crashes (last_seen);

-- Non-fatal error samples from the daily rollup (errors.samples), per install, day and group.
CREATE TABLE errors (
  install_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  module     TEXT NOT NULL,
  group_key  TEXT NOT NULL,
  version    TEXT NOT NULL,
  channel    TEXT NOT NULL,
  count      INTEGER NOT NULL,
  message    TEXT NOT NULL,
  PRIMARY KEY (install_id, day, module, group_key)
);
CREATE INDEX errors_day ON errors (day);

-- Daily rollups, stored whole (minus errors.samples, which live in `errors`) for json_extract.
CREATE TABLE daily (
  install_id   TEXT NOT NULL,
  day          TEXT NOT NULL,
  version      TEXT NOT NULL,
  channel      TEXT NOT NULL,
  install_form TEXT NOT NULL,
  os           TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  payload      TEXT NOT NULL,
  PRIMARY KEY (install_id, day)
);
CREATE INDEX daily_day ON daily (day);

CREATE TABLE heartbeats (
  install_id  TEXT NOT NULL,
  day         TEXT NOT NULL,
  version     TEXT NOT NULL,
  channel     TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload     TEXT NOT NULL,
  PRIMARY KEY (install_id, day)
);
CREATE INDEX heartbeats_day ON heartbeats (day);

-- Onboarding steps: the first report of each step per install wins.
CREATE TABLE funnel (
  install_id   TEXT NOT NULL,
  step         TEXT NOT NULL,
  source       TEXT NOT NULL,
  detail       TEXT,
  at           TEXT NOT NULL,
  version      TEXT NOT NULL,
  channel      TEXT NOT NULL,
  install_form TEXT NOT NULL,
  os           TEXT NOT NULL,
  PRIMARY KEY (install_id, step)
);
CREATE INDEX funnel_at ON funnel (at);

CREATE TABLE upgrades (
  id              INTEGER PRIMARY KEY,
  install_id      TEXT NOT NULL,
  at              TEXT NOT NULL,
  channel         TEXT NOT NULL,
  from_version    TEXT NOT NULL,
  to_version      TEXT NOT NULL,
  method          TEXT NOT NULL,
  stage           TEXT NOT NULL,
  duration_s      REAL,
  failure_class   TEXT,
  failure_message TEXT
);
CREATE INDEX upgrades_at ON upgrades (at);

CREATE TABLE migration_failures (
  id          INTEGER PRIMARY KEY,
  install_id  TEXT NOT NULL,
  at          TEXT NOT NULL,
  version     TEXT NOT NULL,
  channel     TEXT NOT NULL,
  migration   TEXT NOT NULL,
  error_class TEXT NOT NULL,
  message     TEXT NOT NULL
);
CREATE INDEX migration_failures_at ON migration_failures (at);
