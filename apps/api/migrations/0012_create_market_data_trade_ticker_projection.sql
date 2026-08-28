ALTER TABLE market_data.projection_generations
  DROP CONSTRAINT market_data_projection_generations_name_check;

ALTER TABLE market_data.projection_generations
  ADD CONSTRAINT market_data_projection_generations_name_check CHECK (
    projection_name IN ('level_two_order_book', 'trade_ticker')
  );

INSERT INTO market_data.projection_generations (
  projection_name,
  status,
  activated_at
) VALUES (
  'trade_ticker',
  'active',
  NOW()
);

CREATE TABLE market_data.ticker_trades (
  generation_id UUID NOT NULL,
  market_code TEXT NOT NULL,
  trade_id UUID NOT NULL,
  market_sequence BIGINT NOT NULL,
  execution_sequence BIGINT NOT NULL,
  price_ticks NUMERIC(38, 0) NOT NULL,
  quantity_lots NUMERIC(38, 0) NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL,
  projected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (generation_id, market_code, trade_id),
  CONSTRAINT market_data_ticker_trades_generation_fk
    FOREIGN KEY (generation_id)
    REFERENCES market_data.projection_generations (id)
    ON DELETE CASCADE,
  CONSTRAINT market_data_ticker_trades_market_code_check CHECK (
    market_code ~ '^[A-Z0-9]+-[A-Z0-9]+$'
  ),
  CONSTRAINT market_data_ticker_trades_market_sequence_check CHECK (market_sequence > 0),
  CONSTRAINT market_data_ticker_trades_execution_sequence_check CHECK (execution_sequence > 0),
  CONSTRAINT market_data_ticker_trades_price_check CHECK (price_ticks > 0),
  CONSTRAINT market_data_ticker_trades_quantity_check CHECK (quantity_lots > 0),
  CONSTRAINT market_data_ticker_trades_market_sequence_unique
    UNIQUE (generation_id, market_code, market_sequence),
  CONSTRAINT market_data_ticker_trades_execution_sequence_unique
    UNIQUE (generation_id, market_code, execution_sequence)
);

CREATE INDEX market_data_ticker_trades_window_idx
  ON market_data.ticker_trades (
    generation_id,
    market_code,
    executed_at DESC,
    execution_sequence DESC
  )
  INCLUDE (price_ticks, quantity_lots);

UPDATE atlas_system_metadata
SET value = '12', updated_at = NOW()
WHERE key = 'schema_version';
