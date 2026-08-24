CREATE UNIQUE INDEX financial_ledger_accounts_system_kind_unique
ON financial.ledger_accounts (asset_code, kind)
WHERE wallet_id IS NULL;

INSERT INTO financial.assets (code, display_name, ledger_scale, status)
VALUES
  ('BTC', 'Bitcoin', 8, 'active'),
  ('ETH', 'Ethereum', 18, 'active'),
  ('USD', 'US Dollar', 2, 'active');

INSERT INTO financial.ledger_accounts (asset_code, kind)
SELECT asset.code, account_kind.kind
FROM financial.assets AS asset
CROSS JOIN (
  VALUES ('external_custody'), ('fee_revenue')
) AS account_kind(kind)
WHERE asset.code IN ('BTC', 'ETH', 'USD')
ORDER BY asset.code, account_kind.kind;

UPDATE atlas_system_metadata
SET value = '5', updated_at = NOW()
WHERE key = 'schema_version';
