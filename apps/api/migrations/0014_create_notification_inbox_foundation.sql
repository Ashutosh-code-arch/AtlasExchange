CREATE SCHEMA notifications;

CREATE TABLE notifications.inbox (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  owner_id UUID NOT NULL,
  kind TEXT NOT NULL,
  schema_version SMALLINT NOT NULL,
  source_id UUID NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notifications_inbox_kind_check CHECK (
    kind IN ('financial.deposit_credited', 'financial.withdrawal_completed')
  ),
  CONSTRAINT notifications_inbox_schema_version_check CHECK (schema_version = 1),
  CONSTRAINT notifications_inbox_payload_check CHECK (
    jsonb_typeof(payload) = 'object' AND
    payload = jsonb_build_object(
      'assetCode', payload ->> 'assetCode',
      'amount', payload ->> 'amount'
    ) AND
    jsonb_typeof(payload -> 'assetCode') = 'string' AND
    LENGTH(payload ->> 'assetCode') BETWEEN 2 AND 16 AND
    payload ->> 'assetCode' ~ '^[A-Z0-9]+$' AND
    payload ->> 'assetCode' ~ '[A-Z]' AND
    jsonb_typeof(payload -> 'amount') = 'string' AND
    LENGTH(payload ->> 'amount') BETWEEN 1 AND 57 AND
    payload ->> 'amount' ~ '^(?:[1-9][0-9]*|(?:0|[1-9][0-9]*)\.[0-9]*[1-9])$'
  ),
  CONSTRAINT notifications_inbox_source_unique UNIQUE (owner_id, kind, source_id)
);

CREATE INDEX notifications_inbox_owner_timeline_idx
  ON notifications.inbox (owner_id, occurred_at DESC, id DESC)
  INCLUDE (kind, source_id, payload, created_at);

CREATE TABLE notifications.read_receipts (
  notification_id UUID PRIMARY KEY,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT notifications_read_receipts_notification_fk
    FOREIGN KEY (notification_id)
    REFERENCES notifications.inbox (id)
    ON DELETE RESTRICT
);

CREATE FUNCTION notifications.reject_immutable_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Notification records and read receipts are immutable';
END;
$$;

CREATE TRIGGER notifications_inbox_immutable
BEFORE UPDATE OR DELETE ON notifications.inbox
FOR EACH ROW EXECUTE FUNCTION notifications.reject_immutable_mutation();

CREATE TRIGGER notifications_read_receipts_immutable
BEFORE UPDATE OR DELETE ON notifications.read_receipts
FOR EACH ROW EXECUTE FUNCTION notifications.reject_immutable_mutation();

UPDATE atlas_system_metadata
SET value = '14', updated_at = NOW()
WHERE key = 'schema_version';
