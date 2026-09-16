/**
 * Account-service schema: member accounts and spawned-instance registration.
 * Lives in the database named by TEAM_DB_URL. Table names are prefixed
 * `dsh_` so the store can coexist with other applications in one database.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dsh_users (
  user_id       TEXT PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'member',
  status        TEXT NOT NULL DEFAULT 'active',
  password_hash TEXT NOT NULL,
  agent_token   TEXT NOT NULL,
  idle_exempt   BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keep an existing table (created before idle_exempt existed) in sync.
ALTER TABLE dsh_users ADD COLUMN IF NOT EXISTS idle_exempt BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS dsh_instances (
  user_id      TEXT PRIMARY KEY REFERENCES dsh_users(user_id) ON DELETE CASCADE,
  port         INTEGER NOT NULL,
  pid          INTEGER,
  launch_token TEXT,
  launched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keep an existing table (created before launch_token existed) in sync.
ALTER TABLE dsh_instances ADD COLUMN IF NOT EXISTS launch_token TEXT;
ALTER TABLE dsh_instances ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Self-service registration requests. A row is the pending request, not an
-- account: the account is created only when the operator approves. The status
-- column is pending | approved | rejected | notify_failed; a failed operator
-- notification is its own status so the applicant can retry the same address
-- instead of being locked out by an undelivered request.
CREATE TABLE IF NOT EXISTS dsh_registrations (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  username     TEXT NOT NULL,
  display_name TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  token_hash   TEXT,
  reason       TEXT,
  decided_at   TIMESTAMPTZ,
  decided_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One open request per address and per account name. Decided rows stay for
-- audit without blocking a later request, and an undelivered request is not
-- open either, so the applicant can retry the same address.
CREATE UNIQUE INDEX IF NOT EXISTS dsh_registrations_open_email
  ON dsh_registrations (lower(email)) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS dsh_registrations_open_username
  ON dsh_registrations (username) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS dsh_registrations_token
  ON dsh_registrations (token_hash) WHERE token_hash IS NOT NULL;
`
