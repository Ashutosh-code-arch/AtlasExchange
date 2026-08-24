ALTER TABLE financial.ledger_accounts
ADD CONSTRAINT financial_ledger_accounts_id_asset_unique UNIQUE (id, asset_code);

CREATE TABLE financial.journal_transactions (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  operation_type TEXT NOT NULL,
  idempotency_scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  business_references JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT financial_journal_transactions_idempotency_unique
    UNIQUE (idempotency_scope, idempotency_key),
  CONSTRAINT financial_journal_transactions_operation_type_check CHECK (
    operation_type ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  CONSTRAINT financial_journal_transactions_scope_check CHECK (
    idempotency_scope ~ '^[a-z][a-z0-9_.:-]{0,99}$'
  ),
  CONSTRAINT financial_journal_transactions_key_check CHECK (
    idempotency_key = BTRIM(idempotency_key)
    AND CHAR_LENGTH(idempotency_key) BETWEEN 1 AND 200
  ),
  CONSTRAINT financial_journal_transactions_intent_hash_check CHECK (
    intent_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT financial_journal_transactions_references_check CHECK (
    JSONB_TYPEOF(business_references) = 'object'
  )
);

CREATE TABLE financial.journal_postings (
  journal_id UUID NOT NULL,
  position INTEGER NOT NULL,
  account_id UUID NOT NULL,
  asset_code TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  CONSTRAINT financial_journal_postings_pk PRIMARY KEY (journal_id, position),
  CONSTRAINT financial_journal_postings_position_check CHECK (position >= 1),
  CONSTRAINT financial_journal_postings_direction_check CHECK (
    direction IN ('debit', 'credit')
  ),
  CONSTRAINT financial_journal_postings_amount_check CHECK (
    amount > 0
    AND SCALE(amount) = 0
    AND amount < 100000000000000000000000000000000000000::NUMERIC
  ),
  CONSTRAINT financial_journal_postings_journal_fk
    FOREIGN KEY (journal_id)
    REFERENCES financial.journal_transactions (id)
    ON DELETE RESTRICT,
  CONSTRAINT financial_journal_postings_account_asset_fk
    FOREIGN KEY (account_id, asset_code)
    REFERENCES financial.ledger_accounts (id, asset_code)
    ON DELETE RESTRICT
);

CREATE INDEX financial_journal_postings_account_idx
  ON financial.journal_postings (account_id, journal_id);

CREATE INDEX financial_journal_postings_asset_idx
  ON financial.journal_postings (asset_code, journal_id);

COMMENT ON COLUMN financial.journal_postings.amount IS
  'Positive integral atomic units, constrained to at most 38 digits';

CREATE FUNCTION financial.assert_journal_integrity(target_journal_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  posting_count INTEGER;
  first_position INTEGER;
  last_position INTEGER;
BEGIN
  IF target_journal_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM financial.journal_transactions WHERE id = target_journal_id
  ) THEN
    RETURN;
  END IF;

  SELECT COUNT(*), MIN(position), MAX(position)
  INTO posting_count, first_position, last_position
  FROM financial.journal_postings
  WHERE journal_id = target_journal_id;

  IF posting_count < 2 THEN
    RAISE EXCEPTION 'Financial journal % must contain at least two postings', target_journal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_journal_posting_count_check';
  END IF;

  IF first_position <> 1 OR last_position <> posting_count THEN
    RAISE EXCEPTION 'Financial journal % posting positions must be contiguous from one', target_journal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_journal_posting_sequence_check';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM financial.journal_postings
    WHERE journal_id = target_journal_id
    GROUP BY asset_code
    HAVING SUM(CASE direction WHEN 'debit' THEN amount ELSE -amount END) <> 0
  ) THEN
    RAISE EXCEPTION 'Financial journal % must balance independently per asset', target_journal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_journal_balance_check';
  END IF;

  PERFORM account.id
  FROM financial.ledger_accounts AS account
  WHERE account.id IN (
    SELECT posting.account_id
    FROM financial.journal_postings AS posting
    WHERE posting.journal_id = target_journal_id
  )
  ORDER BY account.id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM financial.ledger_accounts AS account
    INNER JOIN financial.journal_postings AS posting ON posting.account_id = account.id
    WHERE account.id IN (
      SELECT affected.account_id
      FROM financial.journal_postings AS affected
      WHERE affected.journal_id = target_journal_id
    )
      AND account.kind IN ('user_available', 'user_reserved')
    GROUP BY account.id
    HAVING SUM(
      CASE posting.direction WHEN 'credit' THEN posting.amount ELSE -posting.amount END
    ) < 0
  ) THEN
    RAISE EXCEPTION 'Financial journal % would make a user account negative', target_journal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_user_account_balance_non_negative_check';
  END IF;
END;
$$;

CREATE FUNCTION financial.check_journal_integrity_from_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM financial.assert_journal_integrity(NEW.id);
  RETURN NULL;
END;
$$;

CREATE FUNCTION financial.check_journal_integrity_from_posting()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM financial.assert_journal_integrity(NEW.journal_id);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM financial.assert_journal_integrity(OLD.journal_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_journal_transactions_integrity_trigger
AFTER INSERT ON financial.journal_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION financial.check_journal_integrity_from_journal();

CREATE CONSTRAINT TRIGGER financial_journal_postings_integrity_trigger
AFTER INSERT OR UPDATE OR DELETE ON financial.journal_postings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION financial.check_journal_integrity_from_posting();

CREATE FUNCTION financial.reject_journal_fact_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Committed Financial journal facts are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'financial_journal_facts_immutable';
END;
$$;

CREATE TRIGGER financial_journal_transactions_immutable_trigger
BEFORE UPDATE OR DELETE ON financial.journal_transactions
FOR EACH ROW
EXECUTE FUNCTION financial.reject_journal_fact_mutation();

CREATE TRIGGER financial_journal_postings_immutable_trigger
BEFORE UPDATE OR DELETE ON financial.journal_postings
FOR EACH ROW
EXECUTE FUNCTION financial.reject_journal_fact_mutation();

UPDATE atlas_system_metadata
SET value = '4', updated_at = NOW()
WHERE key = 'schema_version';
