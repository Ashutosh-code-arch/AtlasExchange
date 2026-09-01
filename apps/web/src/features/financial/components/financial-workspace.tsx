import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FinancialAsset, FinancialWallet, SimulatedWithdrawal } from "@atlas/contracts";

import { ApiHttpError, ApiTransportError } from "../../../shared/api/http-client";
import { useAuthenticationSession, type AuthenticationHttpClient } from "../../authentication";
import { createFinancialWallet } from "../api/create-financial-wallet";
import { createSimulatedDeposit } from "../api/create-simulated-deposit";
import { createSimulatedWithdrawal } from "../api/create-simulated-withdrawal";
import { listFinancialAssets } from "../api/list-financial-assets";
import { listFinancialWallets } from "../api/list-financial-wallets";

type AssetLoader = typeof listFinancialAssets;
type WalletLoader = typeof listFinancialWallets;
type WalletCreator = typeof createFinancialWallet;
type DepositCreator = typeof createSimulatedDeposit;
type WithdrawalCreator = typeof createSimulatedWithdrawal;

interface PendingIntent {
  readonly assetCode: string;
  readonly amount: string;
  readonly idempotencyKey: string;
}

interface Feedback {
  readonly tone: "error" | "notice" | "success";
  readonly message: string;
}

export interface FinancialWorkspaceProps {
  readonly assetLoader?: AssetLoader;
  readonly walletLoader?: WalletLoader;
  readonly walletCreator?: WalletCreator;
  readonly depositCreator?: DepositCreator;
  readonly withdrawalCreator?: WithdrawalCreator;
  readonly idempotencyKeyFactory?: () => string;
}

interface AuthenticatedFinancialWorkspaceProps extends Required<FinancialWorkspaceProps> {
  readonly request: AuthenticationHttpClient["request"];
}

function defaultIdempotencyKeyFactory(): string {
  return globalThis.crypto.randomUUID();
}

function isAmbiguousOutcome(error: unknown): boolean {
  return (
    error instanceof ApiTransportError || (error instanceof ApiHttpError && error.status >= 500)
  );
}

function financialActionError(error: unknown, action: "deposit" | "wallet" | "withdrawal"): string {
  if (!(error instanceof ApiHttpError)) {
    return action === "withdrawal"
      ? "The withdrawal could not be completed. Check the amount and try again."
      : action === "deposit"
        ? "Simulated funding could not be completed. Check the amount and try again."
        : "The wallet could not be opened. Try again.";
  }

  switch (error.code) {
    case "INSUFFICIENT_AVAILABLE_BALANCE":
      return "Available balance is too low for this withdrawal.";
    case "WALLET_NOT_FOUND":
      return "Open a wallet for this asset before withdrawing.";
    case "ASSET_NOT_FOUND":
      return "This asset is no longer available in the Atlas catalog.";
    case "ASSET_UNAVAILABLE":
      return "This asset is not accepting new simulated activity.";
    case "SIMULATED_FUNDING_UNAVAILABLE":
      return "Simulated funding is currently unavailable.";
    case "SIMULATED_WITHDRAWALS_UNAVAILABLE":
      return "Simulated withdrawals are currently unavailable.";
    case "IDEMPOTENCY_CONFLICT":
      return "This retry no longer matches the original request. Start a new attempt.";
    case "RATE_LIMITED":
      return "Too many new simulated requests. Wait before trying a new intent.";
    case "VALIDATION_FAILED":
      return "Enter a canonical positive decimal amount, such as 1.25.";
    default:
      return `${action === "wallet" ? "Wallet creation" : action === "deposit" ? "Simulated funding" : "Simulated withdrawal"} is unavailable. Try again.`;
  }
}

function selectIntent(
  current: PendingIntent | null,
  assetCode: string,
  amount: string,
  createKey: () => string,
): PendingIntent {
  return current?.assetCode === assetCode && current.amount === amount
    ? current
    : { assetCode, amount, idempotencyKey: createKey() };
}

function AuthenticatedFinancialWorkspace({
  request,
  assetLoader,
  walletLoader,
  walletCreator,
  depositCreator,
  withdrawalCreator,
  idempotencyKeyFactory,
}: AuthenticatedFinancialWorkspaceProps): React.JSX.Element {
  const [assets, setAssets] = useState<readonly FinancialAsset[]>([]);
  const [wallets, setWallets] = useState<readonly FinancialWallet[]>([]);
  const [selectedAssetCode, setSelectedAssetCode] = useState("");
  const [loadState, setLoadState] = useState<"error" | "loading" | "ready">("loading");
  const [operation, setOperation] = useState<"deposit" | "wallet" | "withdrawal" | null>(null);
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawalAmount, setWithdrawalAmount] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [withdrawalReceipt, setWithdrawalReceipt] = useState<SimulatedWithdrawal | null>(null);
  const depositIntentRef = useRef<PendingIntent | null>(null);
  const withdrawalIntentRef = useRef<PendingIntent | null>(null);

  const refreshWallets = useCallback(async (): Promise<void> => {
    setWallets(await walletLoader({ request }));
  }, [request, walletLoader]);

  useEffect(() => {
    let current = true;
    Promise.all([assetLoader({ request }), walletLoader({ request })])
      .then(([catalog, ownedWallets]) => {
        if (!current) {
          return;
        }
        setAssets(catalog);
        setWallets(ownedWallets);
        setSelectedAssetCode((existing) => {
          if (catalog.some((asset) => asset.code === existing && asset.status === "active")) {
            return existing;
          }
          return catalog.find((asset) => asset.status === "active")?.code ?? "";
        });
        setLoadState("ready");
      })
      .catch(() => {
        if (current) {
          setLoadState("error");
        }
      });

    return () => {
      current = false;
    };
  }, [assetLoader, request, walletLoader]);

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.code === selectedAssetCode),
    [assets, selectedAssetCode],
  );
  const selectedWallet = useMemo(
    () => wallets.find((wallet) => wallet.assetCode === selectedAssetCode),
    [selectedAssetCode, wallets],
  );
  const busy = operation !== null;

  const refreshAfterSuccess = async (successMessage: string): Promise<void> => {
    try {
      await refreshWallets();
      setFeedback({ tone: "success", message: successMessage });
    } catch {
      setFeedback({
        tone: "notice",
        message: `${successMessage} Refresh the portfolio to load the latest balance.`,
      });
    }
  };

  const openWallet = (): void => {
    if (selectedAsset === undefined || busy) {
      return;
    }
    setOperation("wallet");
    setFeedback(null);
    void walletCreator({ request }, selectedAsset.code)
      .then(() => refreshAfterSuccess(`${selectedAsset.code} wallet is ready.`))
      .catch((error: unknown) => {
        setFeedback({ tone: "error", message: financialActionError(error, "wallet") });
      })
      .finally(() => setOperation(null));
  };

  const fundWallet = (): void => {
    if (selectedWallet === undefined || depositAmount.length === 0 || busy) {
      return;
    }
    const intent = selectIntent(
      depositIntentRef.current,
      selectedWallet.assetCode,
      depositAmount,
      idempotencyKeyFactory,
    );
    depositIntentRef.current = intent;
    setOperation("deposit");
    setFeedback(null);
    void depositCreator({ request }, intent)
      .then(async () => {
        depositIntentRef.current = null;
        setDepositAmount("");
        await refreshAfterSuccess("Simulated funds were credited.");
      })
      .catch((error: unknown) => {
        if (!isAmbiguousOutcome(error)) {
          depositIntentRef.current = null;
        }
        setFeedback({
          tone: isAmbiguousOutcome(error) ? "notice" : "error",
          message: isAmbiguousOutcome(error)
            ? "Funding outcome is unknown. Retry the same amount to reuse the original request."
            : financialActionError(error, "deposit"),
        });
      })
      .finally(() => setOperation(null));
  };

  const withdraw = (): void => {
    if (selectedWallet === undefined || withdrawalAmount.length === 0 || busy) {
      return;
    }
    const intent = selectIntent(
      withdrawalIntentRef.current,
      selectedWallet.assetCode,
      withdrawalAmount,
      idempotencyKeyFactory,
    );
    withdrawalIntentRef.current = intent;
    setOperation("withdrawal");
    setFeedback(null);
    void withdrawalCreator({ request }, intent)
      .then(async (receipt) => {
        withdrawalIntentRef.current = null;
        setWithdrawalReceipt(receipt);
        setWithdrawalAmount("");
        await refreshAfterSuccess(
          "Simulated withdrawal completed. No external asset was transferred.",
        );
      })
      .catch((error: unknown) => {
        if (!isAmbiguousOutcome(error)) {
          withdrawalIntentRef.current = null;
        }
        setFeedback({
          tone: isAmbiguousOutcome(error) ? "notice" : "error",
          message: isAmbiguousOutcome(error)
            ? "Withdrawal outcome is unknown. Retry the same amount to reuse the original request."
            : financialActionError(error, "withdrawal"),
        });
      })
      .finally(() => setOperation(null));
  };

  return loadState === "loading" ? (
    <p className="financial-workspace__gate">Loading your financial workspace…</p>
  ) : loadState === "error" ? (
    <div className="financial-workspace__gate">
      <span>Financial data is unavailable.</span>
      <button className="text-button" type="button" onClick={() => window.location.reload()}>
        Reload workspace
      </button>
    </div>
  ) : (
    <div className="financial-workspace__body">
      <div className="financial-workspace__asset">
        <label htmlFor="financial-asset">Asset</label>
        <select
          id="financial-asset"
          value={selectedAssetCode}
          disabled={busy}
          onChange={(event) => {
            setSelectedAssetCode(event.target.value);
            setFeedback(null);
            setWithdrawalReceipt(null);
            depositIntentRef.current = null;
            withdrawalIntentRef.current = null;
          }}
        >
          {assets.map((asset) => (
            <option key={asset.code} value={asset.code} disabled={asset.status !== "active"}>
              {asset.code} · {asset.displayName}
            </option>
          ))}
        </select>
        <span>Ledger scale: {selectedAsset?.ledgerScale ?? "—"}</span>
      </div>

      {selectedWallet === undefined ? (
        <div className="financial-workspace__empty">
          <p>No {selectedAssetCode} wallet exists for this account.</p>
          <button
            className="primary-button"
            type="button"
            disabled={busy || selectedAsset === undefined}
            onClick={openWallet}
          >
            {operation === "wallet" ? "Opening wallet…" : `Open ${selectedAssetCode} wallet`}
          </button>
        </div>
      ) : (
        <>
          <section className="financial-balance-panel" aria-label="Selected wallet balance">
            <header className="financial-balance-panel__heading">
              <div>
                <p className="eyebrow">Selected wallet</p>
                <h3 id="financial-balance-title">{selectedWallet.assetCode} balance</h3>
              </div>
              <span>Server confirmed</span>
            </header>
            <dl className="financial-balances" aria-label={`${selectedWallet.assetCode} balance`}>
              <div>
                <dt>Available</dt>
                <dd>{selectedWallet.available}</dd>
              </div>
              <div>
                <dt>Reserved</dt>
                <dd>{selectedWallet.reserved}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>{selectedWallet.total}</dd>
              </div>
            </dl>
          </section>

          <div className="financial-actions">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                fundWallet();
              }}
            >
              <p className="eyebrow">Simulated funding</p>
              <h3>Add funds</h3>
              <label htmlFor="deposit-amount">Amount in {selectedWallet.assetCode}</label>
              <input
                id="deposit-amount"
                name="depositAmount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="1.25"
                value={depositAmount}
                disabled={busy}
                required
                onChange={(event) => setDepositAmount(event.target.value)}
              />
              <button className="primary-button" type="submit" disabled={busy}>
                {operation === "deposit" ? "Crediting…" : "Add simulated funds"}
              </button>
            </form>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                withdraw();
              }}
            >
              <p className="eyebrow">Simulated withdrawal</p>
              <h3>Withdraw funds</h3>
              <label htmlFor="withdrawal-amount">Amount in {selectedWallet.assetCode}</label>
              <input
                id="withdrawal-amount"
                name="withdrawalAmount"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.5"
                value={withdrawalAmount}
                disabled={busy}
                required
                onChange={(event) => setWithdrawalAmount(event.target.value)}
              />
              <button className="primary-button" type="submit" disabled={busy}>
                {operation === "withdrawal"
                  ? "Completing withdrawal…"
                  : "Complete simulated withdrawal"}
              </button>
              <small>No destination is collected because no external transfer occurs.</small>
            </form>
          </div>
        </>
      )}

      {feedback === null ? null : (
        <p
          className={`financial-feedback financial-feedback--${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      )}

      {withdrawalReceipt === null ? null : (
        <article className="withdrawal-receipt" aria-labelledby="withdrawal-receipt-title">
          <div>
            <p className="eyebrow">Completed simulation</p>
            <h3 id="withdrawal-receipt-title">
              {withdrawalReceipt.amount} {withdrawalReceipt.assetCode}
            </h3>
          </div>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{withdrawalReceipt.status}</dd>
            </div>
            <div>
              <dt>Method</dt>
              <dd>{withdrawalReceipt.method}</dd>
            </div>
            <div>
              <dt>Withdrawal ID</dt>
              <dd>{withdrawalReceipt.id}</dd>
            </div>
          </dl>
        </article>
      )}
    </div>
  );
}

export function FinancialWorkspace({
  assetLoader = listFinancialAssets,
  walletLoader = listFinancialWallets,
  walletCreator = createFinancialWallet,
  depositCreator = createSimulatedDeposit,
  withdrawalCreator = createSimulatedWithdrawal,
  idempotencyKeyFactory = defaultIdempotencyKeyFactory,
}: FinancialWorkspaceProps): React.JSX.Element {
  const { state, request } = useAuthenticationSession();

  return (
    <section
      className="financial-workspace"
      id="financial"
      aria-labelledby="financial-workspace-title"
    >
      <div className="financial-workspace__heading">
        <div>
          <p className="eyebrow">Wallets and balances</p>
          <h2 id="financial-workspace-title">Simulated funds</h2>
        </div>
        <p>Open asset wallets and test ledger movements without transferring external assets.</p>
      </div>

      {state.status === "authenticated" ? (
        <AuthenticatedFinancialWorkspace
          key={state.user.id}
          request={request}
          assetLoader={assetLoader}
          walletLoader={walletLoader}
          walletCreator={walletCreator}
          depositCreator={depositCreator}
          withdrawalCreator={withdrawalCreator}
          idempotencyKeyFactory={idempotencyKeyFactory}
        />
      ) : (
        <p className="financial-workspace__gate">Sign in to create wallets and use the sandbox.</p>
      )}
    </section>
  );
}
