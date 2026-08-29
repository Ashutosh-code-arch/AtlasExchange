CREATE SCHEMA administration;

ALTER TABLE identity.sessions
  ADD CONSTRAINT identity_sessions_id_user_unique UNIQUE (id, user_id);

CREATE TABLE administration.audit_events (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  operation_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  actor_session_id UUID NOT NULL,
  action TEXT NOT NULL,
  target_user_id UUID NOT NULL,
  reason TEXT NOT NULL,
  details JSONB NOT NULL,
  request_id TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT administration_audit_events_operation_unique UNIQUE (operation_id),
  CONSTRAINT administration_audit_events_actor_user_fk
    FOREIGN KEY (actor_user_id)
    REFERENCES identity.users (id)
    ON DELETE RESTRICT,
  CONSTRAINT administration_audit_events_actor_session_fk
    FOREIGN KEY (actor_session_id, actor_user_id)
    REFERENCES identity.sessions (id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT administration_audit_events_target_user_fk
    FOREIGN KEY (target_user_id)
    REFERENCES identity.users (id)
    ON DELETE RESTRICT,
  CONSTRAINT administration_audit_events_action_check CHECK (
    action IN (
      'identity.user_suspended',
      'identity.user_reactivated',
      'identity.admin_role_granted',
      'identity.admin_role_revoked'
    )
  ),
  CONSTRAINT administration_audit_events_reason_check CHECK (
    LENGTH(reason) BETWEEN 1 AND 500
    AND reason = BTRIM(reason)
    AND reason !~ '[[:cntrl:]]'
  ),
  CONSTRAINT administration_audit_events_request_id_check CHECK (
    request_id ~ '^[A-Za-z0-9_-]{8,128}$'
  ),
  CONSTRAINT administration_audit_events_details_check CHECK (
    jsonb_typeof(details) = 'object'
    AND (
      (
        action = 'identity.user_suspended'
        AND details = jsonb_build_object(
          'previousState', 'active',
          'newState', 'suspended'
        )
      )
      OR (
        action = 'identity.user_reactivated'
        AND details = jsonb_build_object(
          'previousState', 'suspended',
          'newState', 'active'
        )
      )
      OR (
        action IN ('identity.admin_role_granted', 'identity.admin_role_revoked')
        AND details = jsonb_build_object('role', 'admin')
      )
    )
  )
);

CREATE INDEX administration_audit_events_target_timeline_idx
  ON administration.audit_events (target_user_id, occurred_at DESC, id DESC)
  INCLUDE (action, actor_user_id, reason, request_id);

CREATE INDEX administration_audit_events_actor_timeline_idx
  ON administration.audit_events (actor_user_id, occurred_at DESC, id DESC)
  INCLUDE (action, target_user_id, request_id);

CREATE FUNCTION administration.reject_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Administration audit events are immutable';
END;
$$;

CREATE TRIGGER administration_audit_events_immutable
BEFORE UPDATE OR DELETE ON administration.audit_events
FOR EACH ROW EXECUTE FUNCTION administration.reject_audit_mutation();

UPDATE atlas_system_metadata
SET value = '15', updated_at = NOW()
WHERE key = 'schema_version';
