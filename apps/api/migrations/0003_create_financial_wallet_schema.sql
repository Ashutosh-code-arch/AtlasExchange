CREATE SCHEMA financial;

CREATE TABLE financial.assets (
  code TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  ledger_scale SMALLINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT financial_assets_code_check CHECK (
    code ~ '^[A-Z0-9]{2,16}$' AND code ~ '[A-Z]'
  ),
  CONSTRAINT financial_assets_display_name_check CHECK (
    display_name = BTRIM(display_name)
    AND CHAR_LENGTH(display_name) BETWEEN 1 AND 100
  ),
  CONSTRAINT financial_assets_ledger_scale_check CHECK (ledger_scale BETWEEN 0 AND 18),
  CONSTRAINT financial_assets_status_check CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE financial.wallets (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  owner_id UUID NOT NULL,
  asset_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT financial_wallets_owner_asset_unique UNIQUE (owner_id, asset_code),
  CONSTRAINT financial_wallets_id_asset_unique UNIQUE (id, asset_code),
  CONSTRAINT financial_wallets_asset_fk
    FOREIGN KEY (asset_code) REFERENCES financial.assets (code) ON DELETE RESTRICT
);

COMMENT ON COLUMN financial.wallets.owner_id IS
  'Opaque Identity subject identifier; deliberately not a cross-module foreign key';

CREATE INDEX financial_wallets_asset_code_idx ON financial.wallets (asset_code);

CREATE TABLE financial.ledger_accounts (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  asset_code TEXT NOT NULL,
  kind TEXT NOT NULL,
  wallet_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT financial_ledger_accounts_wallet_kind_unique UNIQUE (wallet_id, kind),
  CONSTRAINT financial_ledger_accounts_kind_check CHECK (
    kind IN ('external_custody', 'fee_revenue', 'user_available', 'user_reserved')
  ),
  CONSTRAINT financial_ledger_accounts_ownership_check CHECK (
    (kind IN ('user_available', 'user_reserved') AND wallet_id IS NOT NULL)
    OR (kind IN ('external_custody', 'fee_revenue') AND wallet_id IS NULL)
  ),
  CONSTRAINT financial_ledger_accounts_asset_fk
    FOREIGN KEY (asset_code) REFERENCES financial.assets (code) ON DELETE RESTRICT,
  CONSTRAINT financial_ledger_accounts_wallet_asset_fk
    FOREIGN KEY (wallet_id, asset_code)
    REFERENCES financial.wallets (id, asset_code)
    ON DELETE RESTRICT
);

CREATE INDEX financial_ledger_accounts_asset_kind_idx
  ON financial.ledger_accounts (asset_code, kind);

CREATE FUNCTION financial.assert_wallet_account_pair(target_wallet_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  available_count INTEGER;
  reserved_count INTEGER;
BEGIN
  IF target_wallet_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM financial.wallets WHERE id = target_wallet_id
  ) THEN
    RETURN;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE kind = 'user_available'),
    COUNT(*) FILTER (WHERE kind = 'user_reserved')
  INTO available_count, reserved_count
  FROM financial.ledger_accounts
  WHERE wallet_id = target_wallet_id;

  IF available_count <> 1 OR reserved_count <> 1 THEN
    RAISE EXCEPTION 'Wallet % must own one available and one reserved account', target_wallet_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_wallets_account_pair_check';
  END IF;
END;
$$;

CREATE FUNCTION financial.check_wallet_account_pair_from_wallet()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM financial.assert_wallet_account_pair(NEW.id);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM financial.assert_wallet_account_pair(OLD.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE FUNCTION financial.check_wallet_account_pair_from_account()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.wallet_id IS NOT NULL THEN
    PERFORM financial.assert_wallet_account_pair(NEW.wallet_id);
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.wallet_id IS NOT NULL THEN
    PERFORM financial.assert_wallet_account_pair(OLD.wallet_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_wallets_account_pair_trigger
AFTER INSERT OR UPDATE OR DELETE ON financial.wallets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION financial.check_wallet_account_pair_from_wallet();

CREATE CONSTRAINT TRIGGER financial_ledger_accounts_wallet_pair_trigger
AFTER INSERT OR UPDATE OR DELETE ON financial.ledger_accounts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION financial.check_wallet_account_pair_from_account();

CREATE FUNCTION financial.enforce_asset_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'Financial asset code is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_assets_code_immutable';
  END IF;

  IF NEW.ledger_scale <> OLD.ledger_scale AND (
    EXISTS (SELECT 1 FROM financial.wallets WHERE asset_code = OLD.code)
    OR EXISTS (SELECT 1 FROM financial.ledger_accounts WHERE asset_code = OLD.code)
  ) THEN
    RAISE EXCEPTION 'Financial asset scale is immutable after use'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_assets_ledger_scale_immutable';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER financial_assets_identity_trigger
BEFORE UPDATE ON financial.assets
FOR EACH ROW
EXECUTE FUNCTION financial.enforce_asset_identity();

CREATE FUNCTION financial.enforce_wallet_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.asset_code <> OLD.asset_code THEN
    RAISE EXCEPTION 'Financial wallet identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_wallets_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER financial_wallets_identity_trigger
BEFORE UPDATE ON financial.wallets
FOR EACH ROW
EXECUTE FUNCTION financial.enforce_wallet_identity();

CREATE FUNCTION financial.enforce_ledger_account_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.asset_code <> OLD.asset_code
    OR NEW.kind <> OLD.kind
    OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
  THEN
    RAISE EXCEPTION 'Financial ledger account definition is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_ledger_accounts_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER financial_ledger_accounts_identity_trigger
BEFORE UPDATE ON financial.ledger_accounts
FOR EACH ROW
EXECUTE FUNCTION financial.enforce_ledger_account_identity();

UPDATE atlas_system_metadata
SET value = '3', updated_at = NOW()
WHERE key = 'schema_version';
