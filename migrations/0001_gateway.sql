CREATE TABLE auth_nonces (
  nonce TEXT PRIMARY KEY,
  expires INTEGER NOT NULL
);
CREATE INDEX auth_nonces_expiry ON auth_nonces(expires);

CREATE TABLE admin_sessions (
  digest TEXT PRIMARY KEY,
  password_tag TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);
