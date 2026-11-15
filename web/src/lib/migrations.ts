/**
 * Versioned schema migrations. Append only: never edit a migration that has shipped; add a new one.
 * Embedded as strings (instead of .sql files) so they work the same under Next.js, scripts and tests.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_init',
    sql: `
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email_verified INTEGER,
  name           TEXT,
  image          TEXT,
  role           TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator')),
  created_at     INTEGER NOT NULL
);

CREATE TABLE accounts (
  provider            TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                TEXT NOT NULL,
  PRIMARY KEY (provider, provider_account_id)
);

CREATE TABLE verification_tokens (
  identifier TEXT NOT NULL,
  token      TEXT NOT NULL,
  expires    INTEGER NOT NULL,
  PRIMARY KEY (identifier, token)
);

CREATE TABLE media (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  file       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_media_owner ON media(owner_id);

CREATE TABLE profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  bio          TEXT NOT NULL DEFAULT '',
  avatar_id    TEXT REFERENCES media(id) ON DELETE SET NULL,
  official     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);

CREATE TABLE themes (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug               TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  hostname           TEXT NOT NULL,
  tags               TEXT NOT NULL DEFAULT '[]',
  appearance         TEXT NOT NULL CHECK (appearance IN ('light','dark','mixed')),
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished')),
  license            TEXT NOT NULL,
  compat_notes       TEXT NOT NULL DEFAULT '',
  current_version_id TEXT,
  unpublished_by     TEXT CHECK (unpublished_by IN ('owner','moderation')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  published_at       INTEGER
);
CREATE INDEX idx_themes_status_published ON themes(status, published_at DESC);
CREATE INDEX idx_themes_owner ON themes(owner_id);
CREATE INDEX idx_themes_host ON themes(hostname);

CREATE TABLE theme_versions (
  id                    TEXT PRIMARY KEY,
  theme_id              TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','retired')),
  hostname              TEXT NOT NULL,
  path_scope            TEXT NOT NULL,
  css                   TEXT NOT NULL,
  format_version        INTEGER NOT NULL,
  min_extension_version TEXT,
  change_notes          TEXT NOT NULL DEFAULT '',
  hash                  TEXT NOT NULL,
  validation_status     TEXT NOT NULL CHECK (validation_status IN ('valid','invalid')),
  validation_report     TEXT NOT NULL DEFAULT '{}',
  created_at            INTEGER NOT NULL,
  published_at          INTEGER,
  UNIQUE (theme_id, version)
);
CREATE INDEX idx_versions_theme ON theme_versions(theme_id);

CREATE TABLE theme_previews (
  id       TEXT PRIMARY KEY,
  theme_id TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('before','after','extra')),
  position INTEGER NOT NULL DEFAULT 0,
  alt      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_previews_theme ON theme_previews(theme_id);

CREATE TABLE saved_themes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  theme_id   TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, theme_id)
);
CREATE INDEX idx_saved_theme ON saved_themes(theme_id);

CREATE TABLE reports (
  id              TEXT PRIMARY KEY,
  theme_id        TEXT NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  reporter_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason          TEXT NOT NULL,
  detail          TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  created_at      INTEGER NOT NULL,
  resolved_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     INTEGER,
  resolution_note TEXT
);
CREATE INDEX idx_reports_status ON reports(status, created_at DESC);

CREATE TABLE moderation_log (
  id         TEXT PRIMARY KEY,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  theme_id   TEXT,
  report_id  TEXT,
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_modlog_created ON moderation_log(created_at DESC);

CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
`,
  },
];
