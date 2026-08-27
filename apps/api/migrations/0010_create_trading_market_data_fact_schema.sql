CREATE TABLE trading.market_publication_sequences (
  market_code TEXT PRIMARY KEY,
  last_sequence BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT trading_market_publication_sequences_market_fk
    FOREIGN KEY (market_code) REFERENCES trading.markets (code) ON DELETE RESTRICT,
  CONSTRAINT trading_market_publication_sequences_value_check CHECK (last_sequence >= 0)
);

INSERT INTO trading.market_publication_sequences (market_code)
SELECT code
FROM trading.markets;

CREATE FUNCTION trading.initialize_market_publication_sequence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO trading.market_publication_sequences (market_code)
  VALUES (NEW.code);
  RETURN NULL;
END;
$$;

CREATE TRIGGER trading_markets_publication_sequence_trigger
AFTER INSERT ON trading.markets
FOR EACH ROW
EXECUTE FUNCTION trading.initialize_market_publication_sequence();

CREATE TABLE trading.market_data_facts (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  market_code TEXT NOT NULL,
  market_sequence BIGINT NOT NULL,
  fact_kind TEXT NOT NULL,
  schema_version SMALLINT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trading_market_data_facts_market_sequence_unique
    UNIQUE (market_code, market_sequence),
  CONSTRAINT trading_market_data_facts_market_fk
    FOREIGN KEY (market_code) REFERENCES trading.markets (code) ON DELETE RESTRICT,
  CONSTRAINT trading_market_data_facts_sequence_check CHECK (market_sequence > 0),
  CONSTRAINT trading_market_data_facts_kind_check CHECK (
    fact_kind IN ('order_state', 'trade_executed')
  ),
  CONSTRAINT trading_market_data_facts_schema_version_check CHECK (schema_version = 1),
  CONSTRAINT trading_market_data_facts_payload_object_check CHECK (
    JSONB_TYPEOF(payload) = 'object'
  ),
  CONSTRAINT trading_market_data_facts_private_payload_check CHECK (
    NOT payload ?| ARRAY[
      'ownerId',
      'buyerOwnerId',
      'sellerOwnerId',
      'idempotencyKey',
      'intentHash',
      'priority',
      'reservationId'
    ]
  ),
  CONSTRAINT trading_market_data_facts_payload_shape_check CHECK (
    (
      fact_kind = 'order_state'
      AND payload ?& ARRAY[
        'orderId',
        'side',
        'limitPriceTicks',
        'remainingLots',
        'status',
        'terminalReason'
      ]
      AND payload->>'orderId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND payload->>'side' IN ('buy', 'sell')
      AND payload->>'limitPriceTicks' ~ '^[1-9][0-9]*$'
      AND payload->>'remainingLots' ~ '^(0|[1-9][0-9]*)$'
      AND payload->>'status' IN ('open', 'partially_filled', 'filled', 'cancelled')
      AND (
        (
          payload->>'status' IN ('open', 'partially_filled')
          AND (payload->>'remainingLots')::NUMERIC > 0
          AND payload->'terminalReason' = 'null'::JSONB
        )
        OR (
          payload->>'status' = 'filled'
          AND payload->>'remainingLots' = '0'
          AND payload->'terminalReason' = 'null'::JSONB
        )
        OR (
          payload->>'status' = 'cancelled'
          AND (payload->>'remainingLots')::NUMERIC > 0
          AND payload->>'terminalReason' IN ('owner_cancelled', 'self_trade_prevention')
        )
      )
    )
    OR (
      fact_kind = 'trade_executed'
      AND payload ?& ARRAY['tradeId', 'quantityLots', 'priceTicks', 'executionSequence']
      AND payload->>'tradeId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND payload->>'quantityLots' ~ '^[1-9][0-9]*$'
      AND payload->>'priceTicks' ~ '^[1-9][0-9]*$'
      AND payload->>'executionSequence' ~ '^[1-9][0-9]*$'
    )
  )
);

CREATE INDEX trading_market_data_facts_market_sequence_idx
  ON trading.market_data_facts (market_code, market_sequence ASC);

CREATE FUNCTION trading.reject_market_data_fact_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Committed Trading Market Data facts are immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'trading_market_data_facts_immutable';
END;
$$;

CREATE TRIGGER trading_market_data_facts_immutable_trigger
BEFORE UPDATE OR DELETE ON trading.market_data_facts
FOR EACH ROW
EXECUTE FUNCTION trading.reject_market_data_fact_mutation();

UPDATE atlas_system_metadata
SET value = '10', updated_at = NOW()
WHERE key = 'schema_version';
