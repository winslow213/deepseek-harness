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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
`
