ALTER TABLE market_data.projection_generations
  DROP CONSTRAINT market_data_projection_generations_name_check;

ALTER TABLE market_data.projection_generations
  ADD CONSTRAINT market_data_projection_generations_name_check CHECK (
    projection_name IN ('level_two_order_book', 'trade_ticker', 'candles')
  );

INSERT INTO market_data.projection_generations (
  projection_name,
  status,
  activated_at
) VALUES (
  'candles',
  'active',
  NOW()
);

CREATE TABLE market_data.candles (
  generation_id UUID NOT NULL,
  market_code TEXT NOT NULL,
  interval TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  bucket_end TIMESTAMPTZ NOT NULL,
  open_execution_sequence BIGINT NOT NULL,
  close_execution_sequence BIGINT NOT NULL,
  open_price_ticks NUMERIC(38, 0) NOT NULL,
  high_price_ticks NUMERIC(38, 0) NOT NULL,
  low_price_ticks NUMERIC(38, 0) NOT NULL,
  close_price_ticks NUMERIC(38, 0) NOT NULL,
  base_volume_lots NUMERIC NOT NULL,
  quote_volume_tick_lots NUMERIC NOT NULL,
  trade_count BIGINT NOT NULL,
  last_sequence BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (generation_id, market_code, interval, bucket_start),
  CONSTRAINT market_data_candles_generation_fk
    FOREIGN KEY (generation_id)
    REFERENCES market_data.projection_generations (id)
    ON DELETE CASCADE,
  CONSTRAINT market_data_candles_market_code_check CHECK (
    market_code ~ '^[A-Z0-9]+-[A-Z0-9]+$'
  ),
  CONSTRAINT market_data_candles_interval_check CHECK (
    interval IN ('1m', '5m', '15m', '1h', '4h', '1d')
  ),
  CONSTRAINT market_data_candles_boundary_check CHECK (
    bucket_end = bucket_start + CASE interval
      WHEN '1m' THEN INTERVAL '1 minute'
      WHEN '5m' THEN INTERVAL '5 minutes'
      WHEN '15m' THEN INTERVAL '15 minutes'
      WHEN '1h' THEN INTERVAL '1 hour'
      WHEN '4h' THEN INTERVAL '4 hours'
      WHEN '1d' THEN INTERVAL '1 day'
    END
  ),
  CONSTRAINT market_data_candles_alignment_check CHECK (
    MOD(
      EXTRACT(EPOCH FROM bucket_start)::NUMERIC,
      CASE interval
        WHEN '1m' THEN 60
        WHEN '5m' THEN 300
        WHEN '15m' THEN 900
        WHEN '1h' THEN 3600
        WHEN '4h' THEN 14400
        WHEN '1d' THEN 86400
      END
    ) = 0
  ),
  CONSTRAINT market_data_candles_execution_sequence_check CHECK (
    open_execution_sequence > 0 AND close_execution_sequence >= open_execution_sequence
  ),
  CONSTRAINT market_data_candles_price_check CHECK (
    open_price_ticks > 0 AND
    high_price_ticks > 0 AND
    low_price_ticks > 0 AND
    close_price_ticks > 0 AND
    high_price_ticks >= low_price_ticks AND
    open_price_ticks BETWEEN low_price_ticks AND high_price_ticks AND
    close_price_ticks BETWEEN low_price_ticks AND high_price_ticks
  ),
  CONSTRAINT market_data_candles_volume_check CHECK (
    base_volume_lots > 0 AND
    base_volume_lots = TRUNC(base_volume_lots) AND
    quote_volume_tick_lots > 0 AND
    quote_volume_tick_lots = TRUNC(quote_volume_tick_lots)
  ),
  CONSTRAINT market_data_candles_trade_count_check CHECK (trade_count > 0),
  CONSTRAINT market_data_candles_last_sequence_check CHECK (last_sequence > 0)
);

CREATE INDEX market_data_candles_history_idx
  ON market_data.candles (
    generation_id,
    market_code,
    interval,
    bucket_start DESC
  )
  INCLUDE (
    bucket_end,
    open_price_ticks,
    high_price_ticks,
    low_price_ticks,
    close_price_ticks,
    base_volume_lots,
    quote_volume_tick_lots,
    trade_count,
    last_sequence
  );

UPDATE atlas_system_metadata
SET value = '13', updated_at = NOW()
WHERE key = 'schema_version';
