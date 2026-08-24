ALTER TABLE financial.wallets
ADD CONSTRAINT financial_wallets_id_owner_asset_unique UNIQUE (id, owner_id, asset_code);

CREATE TABLE financial.deposits (
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
  credited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT financial_deposits_owner_idempotency_unique UNIQUE (owner_id, idempotency_key),
  CONSTRAINT financial_deposits_journal_unique UNIQUE (journal_id),
  CONSTRAINT financial_deposits_amount_check CHECK (
    amount > 0
    AND SCALE(amount) = 0
    AND amount < 100000000000000000000000000000000000000::NUMERIC
  ),
  CONSTRAINT financial_deposits_method_check CHECK (method = 'simulated'),
  CONSTRAINT financial_deposits_status_check CHECK (status = 'credited'),
  CONSTRAINT financial_deposits_key_check CHECK (
    idempotency_key = BTRIM(idempotency_key)
    AND CHAR_LENGTH(idempotency_key) BETWEEN 1 AND 200
  ),
  CONSTRAINT financial_deposits_intent_hash_check CHECK (
    intent_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT financial_deposits_wallet_owner_asset_fk
    FOREIGN KEY (wallet_id, owner_id, asset_code)
    REFERENCES financial.wallets (id, owner_id, asset_code)
    ON DELETE RESTRICT,
  CONSTRAINT financial_deposits_journal_fk
    FOREIGN KEY (journal_id)
    REFERENCES financial.journal_transactions (id)
    ON DELETE RESTRICT
);

CREATE INDEX financial_deposits_wallet_credited_idx
  ON financial.deposits (wallet_id, credited_at DESC, id DESC);

COMMENT ON TABLE financial.deposits IS
  'Successful simulated funding resources; journal postings remain balance authority';

COMMENT ON COLUMN financial.deposits.amount IS
  'Positive integral atomic units at the referenced asset ledger scale';

CREATE FUNCTION financial.assert_simulated_deposit_integrity(target_deposit_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  target_deposit financial.deposits%ROWTYPE;
BEGIN
  SELECT *
  INTO target_deposit
  FROM financial.deposits
  WHERE id = target_deposit_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM financial.journal_transactions AS journal
    WHERE journal.id = target_deposit.journal_id
      AND journal.operation_type = 'simulated_deposit'
      AND journal.idempotency_scope = 'simulated_deposit:' || target_deposit.owner_id::TEXT
      AND journal.idempotency_key = target_deposit.idempotency_key
      AND journal.intent_hash = target_deposit.intent_hash
  ) THEN
    RAISE EXCEPTION 'Simulated deposit % journal identity does not match', target_deposit_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_deposits_journal_identity_check';
  END IF;

  IF (SELECT COUNT(*) FROM financial.journal_postings WHERE journal_id = target_deposit.journal_id) <> 2
    OR NOT EXISTS (
      SELECT 1
      FROM financial.journal_postings AS posting
      INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
      WHERE posting.journal_id = target_deposit.journal_id
        AND posting.position = 1
        AND posting.asset_code = target_deposit.asset_code
        AND posting.direction = 'debit'
        AND posting.amount = target_deposit.amount
        AND account.asset_code = target_deposit.asset_code
        AND account.kind = 'external_custody'
        AND account.wallet_id IS NULL
    )
    OR NOT EXISTS (
      SELECT 1
      FROM financial.journal_postings AS posting
      INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
      WHERE posting.journal_id = target_deposit.journal_id
        AND posting.position = 2
        AND posting.asset_code = target_deposit.asset_code
        AND posting.direction = 'credit'
        AND posting.amount = target_deposit.amount
        AND account.asset_code = target_deposit.asset_code
        AND account.kind = 'user_available'
        AND account.wallet_id = target_deposit.wallet_id
    )
  THEN
    RAISE EXCEPTION 'Simulated deposit % journal postings do not match', target_deposit_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_deposits_journal_postings_check';
  END IF;
END;
$$;

CREATE FUNCTION financial.check_simulated_deposit_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM financial.assert_simulated_deposit_integrity(NEW.id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_deposits_integrity_trigger
AFTER INSERT ON financial.deposits
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION financial.check_simulated_deposit_integrity();

CREATE FUNCTION financial.check_simulated_deposit_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  deposit_id UUID;
BEGIN
  IF NEW.operation_type <> 'simulated_deposit' THEN
    RETURN NULL;
  END IF;

  SELECT id
  INTO deposit_id
  FROM financial.deposits
  WHERE journal_id = NEW.id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Simulated-deposit journal % must own one deposit record', NEW.id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_simulated_deposit_journal_record_check';
  END IF;

  PERFORM financial.assert_simulated_deposit_integrity(deposit_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_simulated_deposit_journal_trigger
AFTER INSERT ON financial.journal_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION financial.check_simulated_deposit_journal();

CREATE FUNCTION financial.reject_deposit_fact_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Credited Financial deposit facts are immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'financial_deposit_facts_immutable';
END;
$$;

CREATE TRIGGER financial_deposits_immutable_trigger
BEFORE UPDATE OR DELETE ON financial.deposits
FOR EACH ROW
EXECUTE FUNCTION financial.reject_deposit_fact_mutation();

UPDATE atlas_system_metadata
SET value = '6', updated_at = NOW()
WHERE key = 'schema_version';
