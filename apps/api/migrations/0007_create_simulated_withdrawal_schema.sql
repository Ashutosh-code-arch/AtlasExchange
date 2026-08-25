CREATE TABLE financial.withdrawals (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  owner_id UUID NOT NULL,
  wallet_id UUID NOT NULL,
  asset_code TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  journal_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT financial_withdrawals_owner_idempotency_unique UNIQUE (owner_id, idempotency_key),
  CONSTRAINT financial_withdrawals_journal_unique UNIQUE (journal_id),
  CONSTRAINT financial_withdrawals_amount_check CHECK (
    amount > 0
    AND SCALE(amount) = 0
    AND amount < 100000000000000000000000000000000000000::NUMERIC
  ),
  CONSTRAINT financial_withdrawals_method_check CHECK (method = 'simulated'),
  CONSTRAINT financial_withdrawals_status_check CHECK (status = 'completed'),
  CONSTRAINT financial_withdrawals_key_check CHECK (
    idempotency_key = BTRIM(idempotency_key)
    AND CHAR_LENGTH(idempotency_key) BETWEEN 1 AND 200
  ),
  CONSTRAINT financial_withdrawals_intent_hash_check CHECK (
    intent_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT financial_withdrawals_wallet_owner_asset_fk
    FOREIGN KEY (wallet_id, owner_id, asset_code)
    REFERENCES financial.wallets (id, owner_id, asset_code)
    ON DELETE RESTRICT,
  CONSTRAINT financial_withdrawals_journal_fk
    FOREIGN KEY (journal_id)
    REFERENCES financial.journal_transactions (id)
    ON DELETE RESTRICT
);

CREATE INDEX financial_withdrawals_wallet_completed_idx
  ON financial.withdrawals (wallet_id, completed_at DESC, id DESC);

COMMENT ON TABLE financial.withdrawals IS
  'Completed simulated withdrawal resources; journal postings remain balance authority';

COMMENT ON COLUMN financial.withdrawals.amount IS
  'Positive integral atomic units at the referenced asset ledger scale';

CREATE FUNCTION financial.assert_simulated_withdrawal_integrity(target_withdrawal_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  target_withdrawal financial.withdrawals%ROWTYPE;
BEGIN
  SELECT *
  INTO target_withdrawal
  FROM financial.withdrawals
  WHERE id = target_withdrawal_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM financial.journal_transactions AS journal
    WHERE journal.id = target_withdrawal.journal_id
      AND journal.operation_type = 'simulated_withdrawal'
      AND journal.idempotency_scope = 'simulated_withdrawal:' || target_withdrawal.owner_id::TEXT
      AND journal.idempotency_key = target_withdrawal.idempotency_key
      AND journal.intent_hash = target_withdrawal.intent_hash
  ) THEN
    RAISE EXCEPTION 'Simulated withdrawal % journal identity does not match', target_withdrawal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_withdrawals_journal_identity_check';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM financial.journal_postings
    WHERE journal_id = target_withdrawal.journal_id
  ) <> 2
    OR NOT EXISTS (
      SELECT 1
      FROM financial.journal_postings AS posting
      INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
      WHERE posting.journal_id = target_withdrawal.journal_id
        AND posting.position = 1
        AND posting.asset_code = target_withdrawal.asset_code
        AND posting.direction = 'debit'
        AND posting.amount = target_withdrawal.amount
        AND account.asset_code = target_withdrawal.asset_code
        AND account.kind = 'user_available'
        AND account.wallet_id = target_withdrawal.wallet_id
    )
    OR NOT EXISTS (
      SELECT 1
      FROM financial.journal_postings AS posting
      INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
      WHERE posting.journal_id = target_withdrawal.journal_id
        AND posting.position = 2
        AND posting.asset_code = target_withdrawal.asset_code
        AND posting.direction = 'credit'
        AND posting.amount = target_withdrawal.amount
        AND account.asset_code = target_withdrawal.asset_code
        AND account.kind = 'external_custody'
        AND account.wallet_id IS NULL
    )
  THEN
    RAISE EXCEPTION 'Simulated withdrawal % journal postings do not match', target_withdrawal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_withdrawals_journal_postings_check';
  END IF;
END;
$$;

CREATE FUNCTION financial.check_simulated_withdrawal_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM financial.assert_simulated_withdrawal_integrity(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_withdrawals_integrity_trigger
AFTER INSERT ON financial.withdrawals
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION financial.check_simulated_withdrawal_integrity();

CREATE FUNCTION financial.check_simulated_withdrawal_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  withdrawal_id UUID;
BEGIN
  IF NEW.operation_type <> 'simulated_withdrawal' THEN
    RETURN NULL;
  END IF;

  SELECT id
  INTO withdrawal_id
  FROM financial.withdrawals
  WHERE journal_id = NEW.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Simulated-withdrawal journal % must own one withdrawal record', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_simulated_withdrawal_journal_record_check';
  END IF;

  PERFORM financial.assert_simulated_withdrawal_integrity(withdrawal_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_simulated_withdrawal_journal_trigger
AFTER INSERT ON financial.journal_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION financial.check_simulated_withdrawal_journal();

CREATE FUNCTION financial.reject_withdrawal_fact_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Completed Financial withdrawal facts are immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'financial_withdrawal_facts_immutable';
END;
$$;

CREATE TRIGGER financial_withdrawals_immutable_trigger
BEFORE UPDATE OR DELETE ON financial.withdrawals
FOR EACH ROW
EXECUTE FUNCTION financial.reject_withdrawal_fact_mutation();

UPDATE atlas_system_metadata
SET value = '7', updated_at = NOW()
WHERE key = 'schema_version';
