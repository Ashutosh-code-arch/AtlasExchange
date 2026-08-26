CREATE SCHEMA trading;

CREATE SEQUENCE trading.order_acceptance_priority_sequence AS BIGINT;
CREATE SEQUENCE trading.trade_execution_sequence AS BIGINT;

CREATE TABLE trading.markets (
  code TEXT PRIMARY KEY,
  base_asset_code TEXT NOT NULL,
  quote_asset_code TEXT NOT NULL,
  base_lot_atomic_units NUMERIC NOT NULL,
  quote_atomic_units_per_price_tick NUMERIC NOT NULL,
  minimum_order_lots NUMERIC NOT NULL,
  maximum_order_lots NUMERIC NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trading_markets_asset_pair_unique UNIQUE (base_asset_code, quote_asset_code),
  CONSTRAINT trading_markets_code_check CHECK (
    code = base_asset_code || '-' || quote_asset_code
    AND code ~ '^[A-Z0-9]{2,16}-[A-Z0-9]{2,16}$'
  ),
  CONSTRAINT trading_markets_assets_distinct_check CHECK (
    base_asset_code <> quote_asset_code
  ),
  CONSTRAINT trading_markets_base_lot_check CHECK (
    base_lot_atomic_units > 0
    AND SCALE(base_lot_atomic_units) = 0
    AND base_lot_atomic_units < 100000000000000000000000000000000000000::NUMERIC
  ),
  CONSTRAINT trading_markets_price_tick_check CHECK (
    quote_atomic_units_per_price_tick > 0
    AND SCALE(quote_atomic_units_per_price_tick) = 0
    AND quote_atomic_units_per_price_tick < 100000000000000000000000000000000000000::NUMERIC
  ),
  CONSTRAINT trading_markets_order_lot_bounds_check CHECK (
    minimum_order_lots > 0
    AND SCALE(minimum_order_lots) = 0
    AND maximum_order_lots >= minimum_order_lots
    AND SCALE(maximum_order_lots) = 0
    AND maximum_order_lots < 100000000000000000000000000000000000000::NUMERIC
    AND maximum_order_lots * base_lot_atomic_units
      < 100000000000000000000000000000000000000::NUMERIC
  ),
  CONSTRAINT trading_markets_status_check CHECK (
    status IN ('active', 'cancel_only', 'disabled')
  ),
  CONSTRAINT trading_markets_base_asset_fk
    FOREIGN KEY (base_asset_code) REFERENCES financial.assets (code) ON DELETE RESTRICT,
  CONSTRAINT trading_markets_quote_asset_fk
    FOREIGN KEY (quote_asset_code) REFERENCES financial.assets (code) ON DELETE RESTRICT
);

CREATE TABLE trading.orders (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  owner_id UUID NOT NULL,
  market_code TEXT NOT NULL,
  side TEXT NOT NULL,
  order_type TEXT NOT NULL,
  time_in_force TEXT NOT NULL,
  original_lots NUMERIC NOT NULL,
  limit_price_ticks NUMERIC NOT NULL,
  filled_lots NUMERIC NOT NULL DEFAULT 0,
  remaining_lots NUMERIC NOT NULL,
  status TEXT NOT NULL,
  terminal_reason TEXT,
  priority BIGINT NOT NULL DEFAULT nextval('trading.order_acceptance_priority_sequence'),
  idempotency_key TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trading_orders_priority_unique UNIQUE (priority),
  CONSTRAINT trading_orders_owner_idempotency_unique UNIQUE (owner_id, idempotency_key),
  CONSTRAINT trading_orders_market_fk
    FOREIGN KEY (market_code) REFERENCES trading.markets (code) ON DELETE RESTRICT,
  CONSTRAINT trading_orders_side_check CHECK (side IN ('buy', 'sell')),
  CONSTRAINT trading_orders_type_check CHECK (order_type = 'limit'),
  CONSTRAINT trading_orders_time_in_force_check CHECK (
    time_in_force = 'good_til_cancelled'
  ),
  CONSTRAINT trading_orders_original_lots_check CHECK (
    original_lots > 0
    AND SCALE(original_lots) = 0
    AND original_lots < 100000000000000000000000000000000000000::NUMERIC
  ),
  CONSTRAINT trading_orders_limit_price_check CHECK (
    limit_price_ticks > 0
    AND SCALE(limit_price_ticks) = 0
    AND limit_price_ticks < 100000000000000000000000000000000000000::NUMERIC
  ),
  CONSTRAINT trading_orders_fill_values_check CHECK (
    filled_lots >= 0
    AND SCALE(filled_lots) = 0
    AND remaining_lots >= 0
    AND SCALE(remaining_lots) = 0
    AND filled_lots + remaining_lots = original_lots
  ),
  CONSTRAINT trading_orders_status_check CHECK (
    status IN ('open', 'partially_filled', 'filled', 'cancelled')
  ),
  CONSTRAINT trading_orders_terminal_reason_check CHECK (
    terminal_reason IS NULL
    OR terminal_reason IN ('owner_cancelled', 'self_trade_prevention')
  ),
  CONSTRAINT trading_orders_lifecycle_check CHECK (
    (
      status = 'open'
      AND filled_lots = 0
      AND remaining_lots > 0
      AND terminal_reason IS NULL
    )
    OR (
      status = 'partially_filled'
      AND filled_lots > 0
      AND remaining_lots > 0
      AND terminal_reason IS NULL
    )
    OR (
      status = 'filled'
      AND filled_lots = original_lots
      AND remaining_lots = 0
      AND terminal_reason IS NULL
    )
    OR (
      status = 'cancelled'
      AND remaining_lots > 0
      AND terminal_reason IS NOT NULL
    )
  ),
  CONSTRAINT trading_orders_priority_check CHECK (priority > 0),
  CONSTRAINT trading_orders_key_check CHECK (
    idempotency_key = BTRIM(idempotency_key)
    AND CHAR_LENGTH(idempotency_key) BETWEEN 1 AND 200
  ),
  CONSTRAINT trading_orders_intent_hash_check CHECK (
    intent_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT trading_orders_version_check CHECK (version >= 0)
);

ALTER SEQUENCE trading.order_acceptance_priority_sequence
OWNED BY trading.orders.priority;

CREATE INDEX trading_orders_owner_history_idx
  ON trading.orders (owner_id, created_at DESC, id DESC);

CREATE INDEX trading_orders_active_sell_matching_idx
  ON trading.orders (market_code, limit_price_ticks ASC, priority ASC, id ASC)
  WHERE side = 'sell' AND status IN ('open', 'partially_filled');

CREATE INDEX trading_orders_active_buy_matching_idx
  ON trading.orders (market_code, limit_price_ticks DESC, priority ASC, id ASC)
  WHERE side = 'buy' AND status IN ('open', 'partially_filled');

CREATE TABLE trading.trades (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  market_code TEXT NOT NULL,
  maker_order_id UUID NOT NULL,
  taker_order_id UUID NOT NULL,
  buyer_order_id UUID NOT NULL,
  seller_order_id UUID NOT NULL,
  quantity_lots NUMERIC NOT NULL,
  price_ticks NUMERIC NOT NULL,
  execution_sequence BIGINT NOT NULL DEFAULT nextval('trading.trade_execution_sequence'),
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trading_trades_execution_sequence_unique UNIQUE (execution_sequence),
  CONSTRAINT trading_trades_market_fk
    FOREIGN KEY (market_code) REFERENCES trading.markets (code) ON DELETE RESTRICT,
  CONSTRAINT trading_trades_maker_order_fk
    FOREIGN KEY (maker_order_id) REFERENCES trading.orders (id) ON DELETE RESTRICT,
  CONSTRAINT trading_trades_taker_order_fk
    FOREIGN KEY (taker_order_id) REFERENCES trading.orders (id) ON DELETE RESTRICT,
  CONSTRAINT trading_trades_buyer_order_fk
    FOREIGN KEY (buyer_order_id) REFERENCES trading.orders (id) ON DELETE RESTRICT,
  CONSTRAINT trading_trades_seller_order_fk
    FOREIGN KEY (seller_order_id) REFERENCES trading.orders (id) ON DELETE RESTRICT,
  CONSTRAINT trading_trades_distinct_roles_check CHECK (
    maker_order_id <> taker_order_id
    AND buyer_order_id <> seller_order_id
  ),
  CONSTRAINT trading_trades_role_set_check CHECK (
    (maker_order_id = buyer_order_id AND taker_order_id = seller_order_id)
    OR (maker_order_id = seller_order_id AND taker_order_id = buyer_order_id)
  ),
  CONSTRAINT trading_trades_quantity_check CHECK (
    quantity_lots > 0
    AND SCALE(quantity_lots) = 0
    AND quantity_lots < 100000000000000000000000000000000000000::NUMERIC
  ),
  CONSTRAINT trading_trades_price_check CHECK (
    price_ticks > 0
    AND SCALE(price_ticks) = 0
    AND price_ticks < 100000000000000000000000000000000000000::NUMERIC
  ),
  CONSTRAINT trading_trades_execution_sequence_check CHECK (execution_sequence > 0)
);

ALTER SEQUENCE trading.trade_execution_sequence
OWNED BY trading.trades.execution_sequence;

CREATE INDEX trading_trades_market_execution_idx
  ON trading.trades (market_code, execution_sequence DESC);

CREATE FUNCTION trading.enforce_market_definition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.code <> OLD.code
    OR NEW.base_asset_code <> OLD.base_asset_code
    OR NEW.quote_asset_code <> OLD.quote_asset_code
    OR NEW.base_lot_atomic_units <> OLD.base_lot_atomic_units
    OR NEW.quote_atomic_units_per_price_tick <> OLD.quote_atomic_units_per_price_tick
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'Trading market identity and increments are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trading_markets_definition_immutable';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trading_markets_definition_trigger
BEFORE UPDATE ON trading.markets
FOR EACH ROW
EXECUTE FUNCTION trading.enforce_market_definition();

CREATE FUNCTION trading.assert_disabled_market_has_no_active_orders()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'disabled' AND EXISTS (
    SELECT 1
    FROM trading.orders
    WHERE market_code = NEW.code
      AND status IN ('open', 'partially_filled')
  ) THEN
    RAISE EXCEPTION 'Disabled Trading market % cannot retain active orders', NEW.code
      USING ERRCODE = '23514',
            CONSTRAINT = 'trading_markets_disabled_active_orders_check';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trading_markets_disabled_state_trigger
AFTER UPDATE OF status ON trading.markets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trading.assert_disabled_market_has_no_active_orders();

CREATE FUNCTION trading.enforce_order_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
    OR NEW.owner_id <> OLD.owner_id
    OR NEW.market_code <> OLD.market_code
    OR NEW.side <> OLD.side
    OR NEW.order_type <> OLD.order_type
    OR NEW.time_in_force <> OLD.time_in_force
    OR NEW.original_lots <> OLD.original_lots
    OR NEW.limit_price_ticks <> OLD.limit_price_ticks
    OR NEW.priority <> OLD.priority
    OR NEW.idempotency_key <> OLD.idempotency_key
    OR NEW.intent_hash <> OLD.intent_hash
    OR NEW.created_at <> OLD.created_at
  THEN
    RAISE EXCEPTION 'Trading order accepted intent is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trading_orders_intent_immutable';
  END IF;

  IF OLD.status IN ('filled', 'cancelled') THEN
    RAISE EXCEPTION 'Terminal Trading order cannot transition'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trading_orders_terminal_immutable';
  END IF;

  IF NEW.filled_lots < OLD.filled_lots
    OR NEW.remaining_lots > OLD.remaining_lots
    OR NEW.version <> OLD.version + 1
  THEN
    RAISE EXCEPTION 'Trading order lifecycle must move monotonically'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trading_orders_transition_monotonic';
  END IF;

  IF (
    OLD.status = 'open'
    AND NEW.status NOT IN ('partially_filled', 'filled', 'cancelled')
  ) OR (
    OLD.status = 'partially_filled'
    AND NEW.status NOT IN ('partially_filled', 'filled', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Trading order status transition is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trading_orders_status_transition';
  END IF;

  IF NEW.status = OLD.status
    AND NEW.filled_lots = OLD.filled_lots
    AND NEW.remaining_lots = OLD.remaining_lots
  THEN
    RAISE EXCEPTION 'Trading order lifecycle update has no effect'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trading_orders_transition_noop';
  END IF;

  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trading_orders_transition_trigger
BEFORE UPDATE ON trading.orders
FOR EACH ROW
EXECUTE FUNCTION trading.enforce_order_transition();

CREATE FUNCTION trading.assert_order_market_is_active()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM trading.markets
    WHERE code = NEW.market_code AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'Trading market % does not accept new orders', NEW.market_code
      USING ERRCODE = '23514',
            CONSTRAINT = 'trading_orders_active_market_check';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trading_orders_active_market_trigger
AFTER INSERT ON trading.orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trading.assert_order_market_is_active();

CREATE FUNCTION trading.reject_order_or_market_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Committed Trading markets and orders cannot be deleted'
    USING ERRCODE = '23514',
          CONSTRAINT = 'trading_authority_delete_forbidden';
END;
$$;

CREATE TRIGGER trading_markets_delete_trigger
BEFORE DELETE ON trading.markets
FOR EACH ROW
EXECUTE FUNCTION trading.reject_order_or_market_delete();

CREATE TRIGGER trading_orders_delete_trigger
BEFORE DELETE ON trading.orders
FOR EACH ROW
EXECUTE FUNCTION trading.reject_order_or_market_delete();

CREATE FUNCTION trading.assert_trade_order_roles()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM trading.markets
    WHERE code = NEW.market_code AND status = 'active'
  ) OR NOT EXISTS (
    SELECT 1 FROM trading.orders
    WHERE id = NEW.maker_order_id AND market_code = NEW.market_code
  ) OR NOT EXISTS (
    SELECT 1 FROM trading.orders
    WHERE id = NEW.taker_order_id AND market_code = NEW.market_code
  ) OR NOT EXISTS (
    SELECT 1 FROM trading.orders
    WHERE id = NEW.buyer_order_id AND market_code = NEW.market_code AND side = 'buy'
  ) OR NOT EXISTS (
    SELECT 1 FROM trading.orders
    WHERE id = NEW.seller_order_id AND market_code = NEW.market_code AND side = 'sell'
  ) THEN
    RAISE EXCEPTION 'Trading trade order roles do not match the market and sides'
      USING ERRCODE = '23514',
            CONSTRAINT = 'trading_trades_order_roles_check';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trading_trades_order_roles_trigger
AFTER INSERT ON trading.trades
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION trading.assert_trade_order_roles();

CREATE FUNCTION trading.reject_trade_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Committed Trading trades are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'trading_trades_immutable';
END;
$$;

CREATE TRIGGER trading_trades_immutable_trigger
BEFORE UPDATE OR DELETE ON trading.trades
FOR EACH ROW
EXECUTE FUNCTION trading.reject_trade_mutation();

INSERT INTO trading.markets (
  code,
  base_asset_code,
  quote_asset_code,
  base_lot_atomic_units,
  quote_atomic_units_per_price_tick,
  minimum_order_lots,
  maximum_order_lots,
  status
)
VALUES
  ('BTC-USD', 'BTC', 'USD', 100000, 1000, 1, 10000, 'active'),
  ('ETH-USD', 'ETH', 'USD', 10000000000000000, 100, 1, 100000, 'active');

UPDATE atlas_system_metadata
SET value = '8', updated_at = NOW()
WHERE key = 'schema_version';
