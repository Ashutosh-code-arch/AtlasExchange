CREATE SCHEMA identity;

CREATE TABLE identity.users (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  display_email TEXT NOT NULL,
  normalized_email TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending_verification',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT identity_users_normalized_email_unique UNIQUE (normalized_email),
  CONSTRAINT identity_users_state_check CHECK (
    state IN ('pending_verification', 'active', 'suspended', 'disabled')
  )
);

CREATE TABLE identity.password_credentials (
  user_id UUID PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT identity_password_credentials_user_fk
    FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT
);

CREATE TABLE identity.roles (
  code TEXT PRIMARY KEY
);

INSERT INTO identity.roles (code)
VALUES ('user'), ('admin');

CREATE TABLE identity.user_roles (
  user_id UUID NOT NULL,
  role_code TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by_user_id UUID,
  PRIMARY KEY (user_id, role_code),
  CONSTRAINT identity_user_roles_user_fk
    FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT identity_user_roles_role_fk
    FOREIGN KEY (role_code) REFERENCES identity.roles (code) ON DELETE RESTRICT,
  CONSTRAINT identity_user_roles_assigner_fk
    FOREIGN KEY (assigned_by_user_id) REFERENCES identity.users (id) ON DELETE RESTRICT
);

CREATE TABLE identity.sessions (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  CONSTRAINT identity_sessions_user_fk
    FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT identity_sessions_absolute_expiry_check CHECK (absolute_expires_at > created_at),
  CONSTRAINT identity_sessions_activity_check CHECK (
    last_activity_at >= created_at AND last_activity_at <= absolute_expires_at
  ),
  CONSTRAINT identity_sessions_revocation_check CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
);

CREATE INDEX identity_sessions_user_id_idx ON identity.sessions (user_id);

CREATE TABLE identity.access_tokens (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  session_id UUID NOT NULL,
  secret_digest BYTEA NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT identity_access_tokens_session_fk
    FOREIGN KEY (session_id) REFERENCES identity.sessions (id) ON DELETE RESTRICT,
  CONSTRAINT identity_access_tokens_secret_digest_length_check
    CHECK (octet_length(secret_digest) = 32),
  CONSTRAINT identity_access_tokens_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT identity_access_tokens_secret_digest_unique UNIQUE (secret_digest)
);

CREATE INDEX identity_access_tokens_session_id_idx ON identity.access_tokens (session_id);

CREATE TABLE identity.refresh_tokens (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  session_id UUID NOT NULL,
  secret_digest BYTEA NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  replaced_by_token_id UUID,
  CONSTRAINT identity_refresh_tokens_session_fk
    FOREIGN KEY (session_id) REFERENCES identity.sessions (id) ON DELETE RESTRICT,
  CONSTRAINT identity_refresh_tokens_replacement_fk
    FOREIGN KEY (replaced_by_token_id)
    REFERENCES identity.refresh_tokens (id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT identity_refresh_tokens_secret_digest_length_check
    CHECK (octet_length(secret_digest) = 32),
  CONSTRAINT identity_refresh_tokens_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT identity_refresh_tokens_replacement_check
    CHECK (replaced_by_token_id IS NULL OR replaced_by_token_id <> id),
  CONSTRAINT identity_refresh_tokens_secret_digest_unique UNIQUE (secret_digest),
  CONSTRAINT identity_refresh_tokens_replacement_unique UNIQUE (replaced_by_token_id)
);

CREATE INDEX identity_refresh_tokens_session_id_idx ON identity.refresh_tokens (session_id);

CREATE UNIQUE INDEX identity_refresh_tokens_one_active_per_session_idx
  ON identity.refresh_tokens (session_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE TABLE identity.email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id UUID NOT NULL,
  secret_digest BYTEA NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT identity_email_verification_tokens_user_fk
    FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT identity_email_verification_tokens_secret_digest_length_check
    CHECK (octet_length(secret_digest) = 32),
  CONSTRAINT identity_email_verification_tokens_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT identity_email_verification_tokens_secret_digest_unique UNIQUE (secret_digest)
);

CREATE INDEX identity_email_verification_tokens_user_id_idx
  ON identity.email_verification_tokens (user_id);

CREATE TABLE identity.password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  user_id UUID NOT NULL,
  secret_digest BYTEA NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT identity_password_reset_tokens_user_fk
    FOREIGN KEY (user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT identity_password_reset_tokens_secret_digest_length_check
    CHECK (octet_length(secret_digest) = 32),
  CONSTRAINT identity_password_reset_tokens_expiry_check CHECK (expires_at > issued_at),
  CONSTRAINT identity_password_reset_tokens_secret_digest_unique UNIQUE (secret_digest)
);

CREATE INDEX identity_password_reset_tokens_user_id_idx
  ON identity.password_reset_tokens (user_id);

CREATE TABLE identity.security_events (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  event_type TEXT NOT NULL,
  actor_user_id UUID,
  target_user_id UUID,
  session_id UUID,
  request_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  CONSTRAINT identity_security_events_actor_user_fk
    FOREIGN KEY (actor_user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT identity_security_events_target_user_fk
    FOREIGN KEY (target_user_id) REFERENCES identity.users (id) ON DELETE RESTRICT,
  CONSTRAINT identity_security_events_session_fk
    FOREIGN KEY (session_id) REFERENCES identity.sessions (id) ON DELETE RESTRICT,
  CONSTRAINT identity_security_events_metadata_check CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX identity_security_events_target_user_occurred_at_idx
  ON identity.security_events (target_user_id, occurred_at DESC);

CREATE INDEX identity_security_events_session_id_idx ON identity.security_events (session_id);

UPDATE atlas_system_metadata
SET value = '2', updated_at = NOW()
WHERE key = 'schema_version';
