import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface MailpitAddress {
  readonly Address: string;
}

interface MailpitMessage {
  readonly Text: string;
  readonly To: readonly MailpitAddress[];
}

const password = "Atlas E2E passphrase 2026!";

function mailpitOrigin(): string {
  const value = process.env.ATLAS_E2E_MAILPIT_ORIGIN;
  if (value === undefined || value.length === 0) {
    throw new Error("ATLAS_E2E_MAILPIT_ORIGIN is required.");
  }
  return value;
}

async function latestVerificationMessage(
  request: APIRequestContext,
  email: string,
): Promise<MailpitMessage | undefined> {
  const response = await request.get(`${mailpitOrigin()}/api/v1/message/latest`);
  if (!response.ok()) return undefined;
  const message = (await response.json()) as MailpitMessage;
  return message.To.some((recipient) => recipient.Address === email) ? message : undefined;
}

async function registerVerifyAndSignIn(
  page: Page,
  request: APIRequestContext,
  email: string,
): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create account" }).click();

  const registration = page.locator("form").filter({ has: page.getByLabel("Confirm password") });
  await registration.getByLabel("Email").fill(email);
  await registration.getByLabel("Password", { exact: true }).fill(password);
  await registration.getByLabel("Confirm password").fill(password);
  await registration.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");

  await expect
    .poll(async () => latestVerificationMessage(request, email), { timeout: 10_000 })
    .not.toBeUndefined();
  const message = await latestVerificationMessage(request, email);
  const verificationUrl = message?.Text.match(/https?:\/\/[^\s]+\/verify-email#token=[^\s]+/)?.[0];
  if (verificationUrl === undefined) {
    throw new Error(`Verification email for ${email} did not contain the capability URL.`);
  }

  await page.goto(verificationUrl);
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  await page.getByRole("link", { name: "Continue to sign in" }).click();
  await signIn(page, email);
}

async function signIn(page: Page, email: string): Promise<void> {
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Sign in" }) });
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Authenticated as")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
}

async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
}

async function selectAsset(page: Page, assetCode: string): Promise<void> {
  const selector = page.locator("#financial-asset");
  await expect(selector).toBeVisible();
  await selector.selectOption(assetCode);
}

async function openWallet(page: Page, assetCode: string): Promise<void> {
  await selectAsset(page, assetCode);
  await page.getByRole("button", { name: `Open ${assetCode} wallet` }).click();
  await expect(page.getByLabel(`${assetCode} balance`)).toBeVisible();
}

async function fundSelectedWallet(page: Page, assetCode: string, amount: string): Promise<void> {
  await page.locator("#deposit-amount").fill(amount);
  await page.getByRole("button", { name: "Add simulated funds" }).click();
  await expect(page.getByText("Simulated funds were credited.")).toBeVisible();
  await expect(page.getByLabel(`${assetCode} balance`).locator("dd").first()).toHaveText(amount);
}

async function expectWalletBalance(
  page: Page,
  assetCode: string,
  expected: { readonly available: string; readonly reserved: string; readonly total: string },
): Promise<void> {
  await selectAsset(page, assetCode);
  const values = page.getByLabel(`${assetCode} balance`).locator("dd");
  await expect(values.nth(0)).toHaveText(expected.available);
  await expect(values.nth(1)).toHaveText(expected.reserved);
  await expect(values.nth(2)).toHaveText(expected.total);
}

async function placeLimitOrder(
  page: Page,
  input: { readonly side: "Buy" | "Sell"; readonly quantity: string; readonly price: string },
): Promise<void> {
  const ticket = page.getByRole("form", { name: "Limit order ticket" });
  await expect(ticket).toBeVisible();
  await page.getByRole("button", { name: input.side, exact: true }).click();
  await ticket.getByLabel("Quantity").fill(input.quantity);
  await ticket.getByLabel("Limit price").fill(input.price);
  await ticket.getByRole("button", { name: `${input.side} BTC` }).click();
}

test("matches two users through the Trading desk, settles wallets, and cancels residual liquidity", async ({
  page,
  request,
}) => {
  const sellerEmail = "seller-browser-journey@atlas.test";
  const buyerEmail = "buyer-browser-journey@atlas.test";

  await registerVerifyAndSignIn(page, request, sellerEmail);
  await openWallet(page, "BTC");
  await fundSelectedWallet(page, "BTC", "1");
  await openWallet(page, "USD");

  await placeLimitOrder(page, { side: "Sell", quantity: "0.5", price: "50000" });
  await expect(page.locator(".trading-feedback")).toContainText(/Order .* is open on BTC-USD/);
  const sellerOrders = page.getByRole("table", { name: "Orders for the selected Trading market" });
  await expect(sellerOrders).toContainText("50000");
  await expect(sellerOrders).toContainText("open");
  await signOut(page);

  await registerVerifyAndSignIn(page, request, buyerEmail);
  await openWallet(page, "BTC");
  await openWallet(page, "USD");
  await fundSelectedWallet(page, "USD", "60000");

  await placeLimitOrder(page, { side: "Buy", quantity: "0.5", price: "51000" });
  await expect(page.locator(".trading-feedback")).toContainText(/executed 1 fill/);
  const buyerExecutions = page.getByRole("table", {
    name: "Executions for the selected Trading market",
  });
  await expect(buyerExecutions).toContainText("50000");
  await expect(buyerExecutions).toContainText("0.5");
  await expect(buyerExecutions).toContainText("25000");
  await expect(buyerExecutions).toContainText("taker");

  await placeLimitOrder(page, { side: "Buy", quantity: "0.1", price: "40000" });
  await expect(page.locator(".trading-feedback")).toContainText(/is open on BTC-USD/);
  await page.getByRole("button", { name: /Cancel BTC-USD buy order/ }).click();
  await expect(page.locator(".trading-feedback")).toContainText(/was cancelled/);
  await expect(page.getByRole("button", { name: /Cancel BTC-USD buy order/ })).toHaveCount(0);

  await page.reload();
  await expect(page.getByText(buyerEmail)).toBeVisible();
  await expectWalletBalance(page, "BTC", { available: "0.5", reserved: "0", total: "0.5" });
  await expectWalletBalance(page, "USD", {
    available: "35000",
    reserved: "0",
    total: "35000",
  });
  await signOut(page);

  await signIn(page, sellerEmail);
  await expectWalletBalance(page, "BTC", { available: "0.5", reserved: "0", total: "0.5" });
  await expectWalletBalance(page, "USD", {
    available: "25000",
    reserved: "0",
    total: "25000",
  });

  await page.getByRole("tab", { name: /Executions 1/ }).click();
  const sellerExecutions = page.getByRole("table", {
    name: "Executions for the selected Trading market",
  });
  await expect(sellerExecutions).toContainText("50000");
  await expect(sellerExecutions).toContainText("0.5");
  await expect(sellerExecutions).toContainText("25000");
  await expect(sellerExecutions).toContainText("maker");
});
