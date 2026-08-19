CREATE TABLE atlas_system_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO atlas_system_metadata (key, value)
VALUES ('schema_version', '1');
