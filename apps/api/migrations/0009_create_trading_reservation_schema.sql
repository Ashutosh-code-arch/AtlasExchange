CREATE TABLE financial.trading_reservations (
  order_id UUID PRIMARY KEY,
  owner_id UUID NOT NULL,
  market_code TEXT NOT NULL,
  side TEXT NOT NULL,
  asset_code TEXT NOT NULL,
  original_amount NUMERIC NOT NULL,
  remaining_amount NUMERIC NOT NULL,
  status TEXT NOT NULL,
  reservation_journal_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT financial_trading_reservations_journal_unique UNIQUE (reservation_journal_id),
  CONSTRAINT financial_trading_reservations_market_check CHECK (
    market_code ~ '^[A-Z0-9]{2,16}-[A-Z0-9]{2,16}$'
  ),
  CONSTRAINT financial_trading_reservations_side_check CHECK (side IN ('buy', 'sell')),
  CONSTRAINT financial_trading_reservations_amount_check CHECK (
    original_amount > 0
    AND SCALE(original_amount) = 0
    AND original_amount < 100000000000000000000000000000000000000::NUMERIC
    AND remaining_amount >= 0
    AND SCALE(remaining_amount) = 0
    AND remaining_amount <= original_amount
  ),
  CONSTRAINT financial_trading_reservations_status_check CHECK (
    status IN ('active', 'consumed', 'released')
  ),
  CONSTRAINT financial_trading_reservations_lifecycle_check CHECK (
    (status = 'active' AND remaining_amount > 0)
    OR (status IN ('consumed', 'released') AND remaining_amount = 0)
  ),
  CONSTRAINT financial_trading_reservations_asset_fk
    FOREIGN KEY (asset_code) REFERENCES financial.assets (code) ON DELETE RESTRICT,
  CONSTRAINT financial_trading_reservations_journal_fk
    FOREIGN KEY (reservation_journal_id)
    REFERENCES financial.journal_transactions (id)
    ON DELETE RESTRICT
);

CREATE TABLE financial.trading_reservation_movements (
  reservation_order_id UUID NOT NULL,
  journal_id UUID NOT NULL,
  movement_kind TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  trade_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT financial_trading_reservation_movements_pk
    PRIMARY KEY (reservation_order_id, journal_id),
  CONSTRAINT financial_trading_reservation_movements_kind_check CHECK (
    movement_kind IN ('trade_settlement', 'release')
  ),
  CONSTRAINT financial_trading_reservation_movements_amount_check CHECK (
    amount > 0
    AND SCALE(amount) = 0
    AND amount < 100000000000000000000000000000000000000::NUMERIC
  ),
  CONSTRAINT financial_trading_reservation_movements_trade_check CHECK (
    (movement_kind = 'trade_settlement' AND trade_id IS NOT NULL)
    OR (movement_kind = 'release' AND trade_id IS NULL)
  ),
  CONSTRAINT financial_trading_reservation_movements_reservation_fk
    FOREIGN KEY (reservation_order_id)
    REFERENCES financial.trading_reservations (order_id)
    ON DELETE RESTRICT,
  CONSTRAINT financial_trading_reservation_movements_journal_fk
    FOREIGN KEY (journal_id)
    REFERENCES financial.journal_transactions (id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX financial_trading_reservation_trade_unique
  ON financial.trading_reservation_movements (reservation_order_id, trade_id)
  WHERE movement_kind = 'trade_settlement';

CREATE UNIQUE INDEX financial_trading_reservation_release_unique
  ON financial.trading_reservation_movements (reservation_order_id)
  WHERE movement_kind = 'release';

CREATE INDEX financial_trading_reservation_movements_journal_idx
  ON financial.trading_reservation_movements (journal_id, reservation_order_id);

CREATE FUNCTION financial.enforce_trading_reservation_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_id <> OLD.order_id
    OR NEW.owner_id <> OLD.owner_id
    OR NEW.market_code <> OLD.market_code
    OR NEW.side <> OLD.side
    OR NEW.asset_code <> OLD.asset_code
    OR NEW.original_amount <> OLD.original_amount
    OR NEW.reservation_journal_id <> OLD.reservation_journal_id
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'Financial Trading reservation identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_reservation_identity_immutable';
  END IF;

  IF OLD.status IN ('consumed', 'released') THEN
    RAISE EXCEPTION 'Terminal Financial Trading reservation cannot transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_reservation_terminal_immutable';
  END IF;

  IF NEW.remaining_amount >= OLD.remaining_amount
    OR NEW.status NOT IN ('active', 'consumed', 'released')
  THEN
    RAISE EXCEPTION 'Financial Trading reservation must decrease monotonically'
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_reservation_transition_monotonic';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER financial_trading_reservations_transition_trigger
BEFORE UPDATE ON financial.trading_reservations
FOR EACH ROW
EXECUTE FUNCTION financial.enforce_trading_reservation_transition();

CREATE FUNCTION financial.reject_trading_reservation_fact_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Financial Trading reservation facts cannot be deleted'
    USING ERRCODE = '23514',
          CONSTRAINT = 'financial_trading_reservation_facts_delete_forbidden';
END;
$$;

CREATE TRIGGER financial_trading_reservations_delete_trigger
BEFORE DELETE ON financial.trading_reservations
FOR EACH ROW
EXECUTE FUNCTION financial.reject_trading_reservation_fact_delete();

CREATE FUNCTION financial.reject_trading_reservation_movement_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Financial Trading reservation movements are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'financial_trading_reservation_movements_immutable';
END;
$$;

CREATE TRIGGER financial_trading_reservation_movements_immutable_trigger
BEFORE UPDATE OR DELETE ON financial.trading_reservation_movements
FOR EACH ROW
EXECUTE FUNCTION financial.reject_trading_reservation_movement_mutation();

CREATE FUNCTION financial.assert_trading_reservation_integrity(target_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  target_reservation financial.trading_reservations%ROWTYPE;
  movement_total NUMERIC;
  release_count INTEGER;
BEGIN
  SELECT *
  INTO target_reservation
  FROM financial.trading_reservations
  WHERE order_id = target_order_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM financial.journal_transactions AS journal
    WHERE journal.id = target_reservation.reservation_journal_id
      AND journal.operation_type = 'trading_order_reservation'
      AND journal.idempotency_scope = 'trading.order.reserve'
      AND journal.idempotency_key = target_reservation.order_id::TEXT
      AND journal.business_references ->> 'source' = 'trading'
      AND journal.business_references ->> 'orderId' = target_reservation.order_id::TEXT
      AND journal.business_references ->> 'ownerId' = target_reservation.owner_id::TEXT
      AND journal.business_references ->> 'marketCode' = target_reservation.market_code
      AND journal.business_references ->> 'side' = target_reservation.side
  ) THEN
    RAISE EXCEPTION 'Financial Trading reservation % journal identity does not match', target_order_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_reservation_journal_identity_check';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM financial.journal_postings
    WHERE journal_id = target_reservation.reservation_journal_id
  ) <> 2
    OR NOT EXISTS (
      SELECT 1
      FROM financial.journal_postings AS posting
      INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
      INNER JOIN financial.wallets AS wallet ON wallet.id = account.wallet_id
      WHERE posting.journal_id = target_reservation.reservation_journal_id
        AND posting.position = 1
        AND posting.asset_code = target_reservation.asset_code
        AND posting.direction = 'debit'
        AND posting.amount = target_reservation.original_amount
        AND account.kind = 'user_available'
        AND account.asset_code = target_reservation.asset_code
        AND wallet.owner_id = target_reservation.owner_id
        AND wallet.asset_code = target_reservation.asset_code
    )
    OR NOT EXISTS (
      SELECT 1
      FROM financial.journal_postings AS posting
      INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
      INNER JOIN financial.wallets AS wallet ON wallet.id = account.wallet_id
      WHERE posting.journal_id = target_reservation.reservation_journal_id
        AND posting.position = 2
        AND posting.asset_code = target_reservation.asset_code
        AND posting.direction = 'credit'
        AND posting.amount = target_reservation.original_amount
        AND account.kind = 'user_reserved'
        AND account.asset_code = target_reservation.asset_code
        AND wallet.owner_id = target_reservation.owner_id
        AND wallet.asset_code = target_reservation.asset_code
    )
  THEN
    RAISE EXCEPTION 'Financial Trading reservation % journal postings do not match', target_order_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_reservation_journal_postings_check';
  END IF;

  SELECT COALESCE(SUM(amount), 0), COUNT(*) FILTER (WHERE movement_kind = 'release')
  INTO movement_total, release_count
  FROM financial.trading_reservation_movements
  WHERE reservation_order_id = target_order_id;

  IF target_reservation.remaining_amount <> target_reservation.original_amount - movement_total
    OR target_reservation.remaining_amount < 0
    OR (target_reservation.status = 'active' AND (
      target_reservation.remaining_amount <= 0 OR release_count <> 0
    ))
    OR (target_reservation.status = 'consumed' AND (
      target_reservation.remaining_amount <> 0 OR release_count <> 0
    ))
    OR (target_reservation.status = 'released' AND (
      target_reservation.remaining_amount <> 0 OR release_count <> 1
    ))
  THEN
    RAISE EXCEPTION 'Financial Trading reservation % does not reconcile with movements', target_order_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_reservation_movement_reconciliation_check';
  END IF;
END;
$$;

CREATE FUNCTION financial.assert_trading_release_journal(target_journal_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  movement_count INTEGER;
  target_movement financial.trading_reservation_movements%ROWTYPE;
  target_reservation financial.trading_reservations%ROWTYPE;
BEGIN
  SELECT COUNT(*)
  INTO movement_count
  FROM financial.trading_reservation_movements
  WHERE journal_id = target_journal_id;

  IF movement_count <> 1 THEN
    RAISE EXCEPTION 'Financial Trading release journal % must own one movement', target_journal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_release_movement_count_check';
  END IF;

  SELECT *
  INTO target_movement
  FROM financial.trading_reservation_movements
  WHERE journal_id = target_journal_id AND movement_kind = 'release';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial Trading release journal % movement kind does not match', target_journal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_release_movement_kind_check';
  END IF;

  SELECT *
  INTO target_reservation
  FROM financial.trading_reservations
  WHERE order_id = target_movement.reservation_order_id;

  IF NOT EXISTS (
    SELECT 1
    FROM financial.journal_transactions AS journal
    WHERE journal.id = target_journal_id
      AND journal.operation_type = 'trading_order_release'
      AND journal.idempotency_scope = 'trading.order.release'
      AND journal.idempotency_key = target_reservation.order_id::TEXT
      AND journal.business_references ->> 'source' = 'trading'
      AND journal.business_references ->> 'orderId' = target_reservation.order_id::TEXT
      AND journal.business_references ->> 'ownerId' = target_reservation.owner_id::TEXT
      AND journal.business_references ->> 'marketCode' = target_reservation.market_code
      AND journal.business_references ->> 'reason' IN (
        'owner_cancelled', 'self_trade_prevention'
      )
  ) THEN
    RAISE EXCEPTION 'Financial Trading release journal % identity does not match', target_journal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_release_journal_identity_check';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM financial.journal_postings
    WHERE journal_id = target_journal_id
  ) <> 2
    OR NOT EXISTS (
      SELECT 1
      FROM financial.journal_postings AS posting
      INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
      INNER JOIN financial.wallets AS wallet ON wallet.id = account.wallet_id
      WHERE posting.journal_id = target_journal_id
        AND posting.position = 1
        AND posting.asset_code = target_reservation.asset_code
        AND posting.direction = 'debit'
        AND posting.amount = target_movement.amount
        AND account.kind = 'user_reserved'
        AND wallet.owner_id = target_reservation.owner_id
        AND wallet.asset_code = target_reservation.asset_code
    )
    OR NOT EXISTS (
      SELECT 1
      FROM financial.journal_postings AS posting
      INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
      INNER JOIN financial.wallets AS wallet ON wallet.id = account.wallet_id
      WHERE posting.journal_id = target_journal_id
        AND posting.position = 2
        AND posting.asset_code = target_reservation.asset_code
        AND posting.direction = 'credit'
        AND posting.amount = target_movement.amount
        AND account.kind = 'user_available'
        AND wallet.owner_id = target_reservation.owner_id
        AND wallet.asset_code = target_reservation.asset_code
    )
  THEN
    RAISE EXCEPTION 'Financial Trading release journal % postings do not match', target_journal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_release_journal_postings_check';
  END IF;
END;
$$;

CREATE FUNCTION financial.assert_trading_settlement_journal(target_journal_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  movement_count INTEGER;
  buyer_order_id UUID;
  buyer_owner_id UUID;
  buyer_market_code TEXT;
  buyer_asset_code TEXT;
  buyer_amount NUMERIC;
  settlement_trade_id UUID;
  seller_order_id UUID;
  seller_owner_id UUID;
  seller_market_code TEXT;
  seller_asset_code TEXT;
  seller_amount NUMERIC;
  posting_count INTEGER;
BEGIN
  SELECT COUNT(*)
  INTO movement_count
  FROM financial.trading_reservation_movements
  WHERE journal_id = target_journal_id;

  SELECT
    reservation.order_id,
    reservation.owner_id,
    reservation.market_code,
    reservation.asset_code,
    movement.amount,
    movement.trade_id
  INTO
    buyer_order_id,
    buyer_owner_id,
    buyer_market_code,
    buyer_asset_code,
    buyer_amount,
    settlement_trade_id
  FROM financial.trading_reservation_movements AS movement
  INNER JOIN financial.trading_reservations AS reservation
    ON reservation.order_id = movement.reservation_order_id
  WHERE movement.journal_id = target_journal_id
    AND movement.movement_kind = 'trade_settlement'
    AND reservation.side = 'buy';

  SELECT
    reservation.order_id,
    reservation.owner_id,
    reservation.market_code,
    reservation.asset_code,
    movement.amount
  INTO
    seller_order_id,
    seller_owner_id,
    seller_market_code,
    seller_asset_code,
    seller_amount
  FROM financial.trading_reservation_movements AS movement
  INNER JOIN financial.trading_reservations AS reservation
    ON reservation.order_id = movement.reservation_order_id
  WHERE movement.journal_id = target_journal_id
    AND movement.movement_kind = 'trade_settlement'
    AND reservation.side = 'sell';

  IF movement_count <> 2
    OR buyer_order_id IS NULL
    OR seller_order_id IS NULL
    OR settlement_trade_id IS NULL
    OR buyer_owner_id = seller_owner_id
    OR buyer_market_code <> seller_market_code
    OR buyer_asset_code = seller_asset_code
    OR EXISTS (
      SELECT 1
      FROM financial.trading_reservation_movements
      WHERE journal_id = target_journal_id
        AND trade_id IS DISTINCT FROM settlement_trade_id
    )
    OR EXISTS (
      SELECT 1
      FROM financial.trading_reservation_movements
      WHERE trade_id = settlement_trade_id
        AND journal_id <> target_journal_id
    )
  THEN
    RAISE EXCEPTION 'Financial Trading settlement journal % movements do not match', target_journal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_settlement_movements_check';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM financial.journal_transactions AS journal
    WHERE journal.id = target_journal_id
      AND journal.operation_type = 'trading_trade_settlement'
      AND journal.idempotency_scope = 'trading.trade.settle'
      AND journal.idempotency_key = settlement_trade_id::TEXT
      AND journal.business_references ->> 'source' = 'trading'
      AND journal.business_references ->> 'tradeId' = settlement_trade_id::TEXT
      AND journal.business_references ->> 'marketCode' = buyer_market_code
      AND journal.business_references ->> 'buyerOrderId' = buyer_order_id::TEXT
      AND journal.business_references ->> 'sellerOrderId' = seller_order_id::TEXT
      AND (
        (
          journal.business_references ->> 'makerOrderId' = buyer_order_id::TEXT
          AND journal.business_references ->> 'takerOrderId' = seller_order_id::TEXT
        )
        OR (
          journal.business_references ->> 'makerOrderId' = seller_order_id::TEXT
          AND journal.business_references ->> 'takerOrderId' = buyer_order_id::TEXT
        )
      )
  ) THEN
    RAISE EXCEPTION 'Financial Trading settlement journal % identity does not match', target_journal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_settlement_journal_identity_check';
  END IF;

  SELECT COUNT(*)
  INTO posting_count
  FROM financial.journal_postings
  WHERE journal_id = target_journal_id;

  IF posting_count NOT IN (4, 5)
    OR NOT EXISTS (
      SELECT 1
      FROM financial.journal_postings AS posting
      INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
      INNER JOIN financial.wallets AS wallet ON wallet.id = account.wallet_id
      WHERE posting.journal_id = target_journal_id
        AND posting.position = 1
        AND posting.asset_code = seller_asset_code
        AND posting.direction = 'debit'
        AND posting.amount = seller_amount
        AND account.kind = 'user_reserved'
        AND wallet.owner_id = seller_owner_id
        AND wallet.asset_code = seller_asset_code
    )
    OR NOT EXISTS (
      SELECT 1
      FROM financial.journal_postings AS posting
      INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
      INNER JOIN financial.wallets AS wallet ON wallet.id = account.wallet_id
      WHERE posting.journal_id = target_journal_id
        AND posting.position = 2
        AND posting.asset_code = seller_asset_code
        AND posting.direction = 'credit'
        AND posting.amount = seller_amount
        AND account.kind = 'user_available'
        AND wallet.owner_id = buyer_owner_id
        AND wallet.asset_code = seller_asset_code
    )
    OR NOT EXISTS (
      SELECT 1
      FROM financial.journal_postings AS posting
      INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
      INNER JOIN financial.wallets AS wallet ON wallet.id = account.wallet_id
      WHERE posting.journal_id = target_journal_id
        AND posting.position = 3
        AND posting.asset_code = buyer_asset_code
        AND posting.direction = 'debit'
        AND posting.amount = buyer_amount
        AND account.kind = 'user_reserved'
        AND wallet.owner_id = buyer_owner_id
        AND wallet.asset_code = buyer_asset_code
    )
    OR NOT EXISTS (
      SELECT 1
      FROM financial.journal_postings AS posting
      INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
      INNER JOIN financial.wallets AS wallet ON wallet.id = account.wallet_id
      WHERE posting.journal_id = target_journal_id
        AND posting.position = 4
        AND posting.asset_code = buyer_asset_code
        AND posting.direction = 'credit'
        AND posting.amount > 0
        AND account.kind = 'user_available'
        AND wallet.owner_id = seller_owner_id
        AND wallet.asset_code = buyer_asset_code
    )
    OR (
      posting_count = 5
      AND NOT EXISTS (
        SELECT 1
        FROM financial.journal_postings AS posting
        INNER JOIN financial.ledger_accounts AS account ON account.id = posting.account_id
        INNER JOIN financial.wallets AS wallet ON wallet.id = account.wallet_id
        WHERE posting.journal_id = target_journal_id
          AND posting.position = 5
          AND posting.asset_code = buyer_asset_code
          AND posting.direction = 'credit'
          AND posting.amount > 0
          AND account.kind = 'user_available'
          AND wallet.owner_id = buyer_owner_id
          AND wallet.asset_code = buyer_asset_code
      )
    )
  THEN
    RAISE EXCEPTION 'Financial Trading settlement journal % postings do not match', target_journal_id
      USING ERRCODE = '23514',
            CONSTRAINT = 'financial_trading_settlement_journal_postings_check';
  END IF;
END;
$$;

CREATE FUNCTION financial.check_trading_reservation_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM financial.assert_trading_reservation_integrity(NEW.order_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_trading_reservations_integrity_trigger
AFTER INSERT OR UPDATE ON financial.trading_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION financial.check_trading_reservation_integrity();

CREATE FUNCTION financial.check_trading_reservation_movement_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM financial.assert_trading_reservation_integrity(NEW.reservation_order_id);
  IF NEW.movement_kind = 'release' THEN
    PERFORM financial.assert_trading_release_journal(NEW.journal_id);
  ELSE
    PERFORM financial.assert_trading_settlement_journal(NEW.journal_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_trading_reservation_movements_integrity_trigger
AFTER INSERT ON financial.trading_reservation_movements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION financial.check_trading_reservation_movement_integrity();

CREATE FUNCTION financial.check_trading_financial_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  reservation_order_id UUID;
BEGIN
  IF NEW.operation_type = 'trading_order_reservation' THEN
    SELECT order_id
    INTO reservation_order_id
    FROM financial.trading_reservations
    WHERE reservation_journal_id = NEW.id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Trading reservation journal % must own one reservation', NEW.id
        USING ERRCODE = '23514',
              CONSTRAINT = 'financial_trading_reservation_journal_record_check';
    END IF;
    PERFORM financial.assert_trading_reservation_integrity(reservation_order_id);
  ELSIF NEW.operation_type = 'trading_order_release' THEN
    PERFORM financial.assert_trading_release_journal(NEW.id);
  ELSIF NEW.operation_type = 'trading_trade_settlement' THEN
    PERFORM financial.assert_trading_settlement_journal(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER financial_trading_journal_integrity_trigger
AFTER INSERT ON financial.journal_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION financial.check_trading_financial_journal();

UPDATE atlas_system_metadata
SET value = '9', updated_at = NOW()
WHERE key = 'schema_version';
