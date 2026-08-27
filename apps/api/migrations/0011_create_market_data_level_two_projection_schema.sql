CREATE SCHEMA market_data;

CREATE TABLE market_data.projection_generations (
  id UUID PRIMARY KEY DEFAULT uuidv7(),
  projection_name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  CONSTRAINT market_data_projection_generations_name_check CHECK (
    projection_name = 'level_two_order_book'
  ),
  CONSTRAINT market_data_projection_generations_status_check CHECK (
    status IN ('building', 'active', 'retired')
  ),
  CONSTRAINT market_data_projection_generations_activation_check CHECK (
    (status = 'building' AND activated_at IS NULL)
    OR (status IN ('active', 'retired') AND activated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX market_data_projection_generations_one_active_idx
  ON market_data.projection_generations (projection_name)
  WHERE status = 'active';

INSERT INTO market_data.projection_generations (
  projection_name,
  status,
  activated_at
) VALUES (
  'level_two_order_book',
  'active',
  NOW()
);

CREATE TABLE market_data.projection_checkpoints (
  generation_id UUID NOT NULL,
  market_code TEXT NOT NULL,
  last_sequence BIGINT NOT NULL DEFAULT 0,
  last_occurred_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (generation_id, market_code),
  CONSTRAINT market_data_projection_checkpoints_generation_fk
    FOREIGN KEY (generation_id)
    REFERENCES market_data.projection_generations (id)
    ON DELETE CASCADE,
  CONSTRAINT market_data_projection_checkpoints_market_code_check CHECK (
    market_code ~ '^[A-Z0-9]+-[A-Z0-9]+$'
  ),
  CONSTRAINT market_data_projection_checkpoints_sequence_check CHECK (last_sequence >= 0),
  CONSTRAINT market_data_projection_checkpoints_occurrence_check CHECK (
    (last_sequence = 0 AND last_occurred_at IS NULL)
    OR (last_sequence > 0 AND last_occurred_at IS NOT NULL)
  )
);

CREATE TABLE market_data.level_two_projected_orders (
  generation_id UUID NOT NULL,
  market_code TEXT NOT NULL,
  order_id UUID NOT NULL,
  side TEXT NOT NULL,
  limit_price_ticks NUMERIC(38, 0) NOT NULL,
  remaining_lots NUMERIC(38, 0) NOT NULL,
  last_sequence BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (generation_id, market_code, order_id),
  CONSTRAINT market_data_level_two_projected_orders_generation_fk
    FOREIGN KEY (generation_id)
    REFERENCES market_data.projection_generations (id)
    ON DELETE CASCADE,
  CONSTRAINT market_data_level_two_projected_orders_market_code_check CHECK (
    market_code ~ '^[A-Z0-9]+-[A-Z0-9]+$'
  ),
  CONSTRAINT market_data_level_two_projected_orders_side_check CHECK (side IN ('buy', 'sell')),
  CONSTRAINT market_data_level_two_projected_orders_price_check CHECK (limit_price_ticks > 0),
  CONSTRAINT market_data_level_two_projected_orders_quantity_check CHECK (remaining_lots > 0),
  CONSTRAINT market_data_level_two_projected_orders_sequence_check CHECK (last_sequence > 0)
);

CREATE INDEX market_data_level_two_projected_orders_level_idx
  ON market_data.level_two_projected_orders (
    generation_id,
    market_code,
    side,
    limit_price_ticks
  );

CREATE TABLE market_data.level_two_order_book_levels (
  generation_id UUID NOT NULL,
  market_code TEXT NOT NULL,
  side TEXT NOT NULL,
  price_ticks NUMERIC(38, 0) NOT NULL,
  aggregate_remaining_lots NUMERIC(38, 0) NOT NULL,
  order_count BIGINT NOT NULL,
  last_sequence BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (generation_id, market_code, side, price_ticks),
  CONSTRAINT market_data_level_two_order_book_levels_generation_fk
    FOREIGN KEY (generation_id)
    REFERENCES market_data.projection_generations (id)
    ON DELETE CASCADE,
  CONSTRAINT market_data_level_two_order_book_levels_market_code_check CHECK (
    market_code ~ '^[A-Z0-9]+-[A-Z0-9]+$'
  ),
  CONSTRAINT market_data_level_two_order_book_levels_side_check CHECK (side IN ('buy', 'sell')),
  CONSTRAINT market_data_level_two_order_book_levels_price_check CHECK (price_ticks > 0),
  CONSTRAINT market_data_level_two_order_book_levels_quantity_check CHECK (
    aggregate_remaining_lots > 0
  ),
  CONSTRAINT market_data_level_two_order_book_levels_order_count_check CHECK (order_count > 0),
  CONSTRAINT market_data_level_two_order_book_levels_sequence_check CHECK (last_sequence > 0)
);

CREATE INDEX market_data_level_two_order_book_levels_snapshot_idx
  ON market_data.level_two_order_book_levels (
    generation_id,
    market_code,
    side,
    price_ticks
  );

UPDATE atlas_system_metadata
SET value = '11', updated_at = NOW()
WHERE key = 'schema_version';
