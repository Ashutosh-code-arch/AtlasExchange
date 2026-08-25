import { z } from "zod";

const financialAssetCodePattern = /^(?=[A-Z0-9]{2,16}$)(?=.*[A-Z])[A-Z0-9]+$/;
const canonicalFinancialQuantityPattern = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const financialIdempotencyKeyPattern = /^[A-Za-z0-9._:-]{1,200}$/;

function isWithinMaximumAtomicDigits(value: string): boolean {
  const [whole = "", fraction = ""] = value.split(".");
  return `${whole === "0" ? "" : whole}${fraction}`.length <= 38;
}

export const financialAssetCodeSchema = z.string().regex(financialAssetCodePattern);

export const financialLedgerScaleSchema = z.number().int().min(0).max(18);

export const financialAssetStatusSchema = z.enum(["active", "disabled"]);

export const financialQuantitySchema = z
  .string()
  .regex(canonicalFinancialQuantityPattern)
  .refine(isWithinMaximumAtomicDigits);

export const positiveFinancialQuantitySchema = financialQuantitySchema.refine(
  (value) => value !== "0",
);

export const financialIdempotencyKeySchema = z.string().regex(financialIdempotencyKeyPattern);

export const financialAssetSchema = z.strictObject({
  code: financialAssetCodeSchema,
  displayName: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => value === value.trim()),
  ledgerScale: financialLedgerScaleSchema,
  status: financialAssetStatusSchema,
});

export const assetCatalogResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({
    assets: z.array(financialAssetSchema),
  }),
});

export const walletParamsSchema = z.strictObject({
  assetCode: financialAssetCodeSchema,
});

export const financialWalletSchema = z.strictObject({
  id: z.uuid(),
  assetCode: financialAssetCodeSchema,
  available: financialQuantitySchema,
  reserved: financialQuantitySchema,
  total: financialQuantitySchema,
});

export const walletListResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({
    wallets: z.array(financialWalletSchema),
  }),
});

export const walletResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({
    wallet: financialWalletSchema,
  }),
});

export const simulatedDepositRequestSchema = z.strictObject({
  assetCode: financialAssetCodeSchema,
  amount: positiveFinancialQuantitySchema,
});

export const simulatedDepositHeadersSchema = z.strictObject({
  "idempotency-key": financialIdempotencyKeySchema,
});

export const simulatedDepositParamsSchema = z.strictObject({
  depositId: z.uuid(),
});

export const simulatedDepositSchema = z.strictObject({
  id: z.uuid(),
  walletId: z.uuid(),
  assetCode: financialAssetCodeSchema,
  amount: positiveFinancialQuantitySchema,
  method: z.literal("simulated"),
  status: z.literal("credited"),
  creditedAt: z.iso.datetime(),
});

export const simulatedDepositResponseSchema = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({
    deposit: simulatedDepositSchema,
  }),
});

export const financialApiErrorCodeSchema = z.enum([
  "ASSET_NOT_FOUND",
  "ASSET_UNAVAILABLE",
  "AUTHENTICATION_REQUIRED",
  "CSRF_FAILED",
  "DEPOSIT_NOT_FOUND",
  "FORBIDDEN",
  "IDEMPOTENCY_CONFLICT",
  "INTERNAL_SERVER_ERROR",
  "RATE_LIMITED",
  "SIMULATED_FUNDING_UNAVAILABLE",
  "VALIDATION_FAILED",
  "WALLET_NOT_FOUND",
]);

export const financialApiErrorResponseSchema = z.strictObject({
  success: z.literal(false),
  error: z.strictObject({
    code: financialApiErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
  }),
});

export type FinancialAssetCode = z.infer<typeof financialAssetCodeSchema>;
export type FinancialLedgerScale = z.infer<typeof financialLedgerScaleSchema>;
export type FinancialAssetStatus = z.infer<typeof financialAssetStatusSchema>;
export type FinancialQuantity = z.infer<typeof financialQuantitySchema>;
export type PositiveFinancialQuantity = z.infer<typeof positiveFinancialQuantitySchema>;
export type FinancialIdempotencyKey = z.infer<typeof financialIdempotencyKeySchema>;
export type FinancialAsset = z.infer<typeof financialAssetSchema>;
export type AssetCatalogResponse = z.infer<typeof assetCatalogResponseSchema>;
export type WalletParams = z.infer<typeof walletParamsSchema>;
export type FinancialWallet = z.infer<typeof financialWalletSchema>;
export type WalletListResponse = z.infer<typeof walletListResponseSchema>;
export type WalletResponse = z.infer<typeof walletResponseSchema>;
export type SimulatedDepositRequest = z.infer<typeof simulatedDepositRequestSchema>;
export type SimulatedDepositHeaders = z.infer<typeof simulatedDepositHeadersSchema>;
export type SimulatedDepositParams = z.infer<typeof simulatedDepositParamsSchema>;
export type SimulatedDeposit = z.infer<typeof simulatedDepositSchema>;
export type SimulatedDepositResponse = z.infer<typeof simulatedDepositResponseSchema>;
export type FinancialApiErrorCode = z.infer<typeof financialApiErrorCodeSchema>;
export type FinancialApiErrorResponse = z.infer<typeof financialApiErrorResponseSchema>;
