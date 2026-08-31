import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

interface MailpitAddress {
  readonly Address: string;
}

interface MailpitMessage {
  readonly Text: string;
  readonly To: readonly MailpitAddress[];
}

const email = "notification-browser-journey@atlas.test";
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
): Promise<MailpitMessage | undefined> {
  const response = await request.get(`${mailpitOrigin()}/api/v1/message/latest`);
  if (!response.ok()) return undefined;
  const message = (await response.json()) as MailpitMessage;
  return message.To.some((recipient) => recipient.Address === email) ? message : undefined;
}

async function registerVerifyAndSignIn(page: Page, request: APIRequestContext): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create account" }).click();
  const registration = page.locator("form").filter({ has: page.getByLabel("Confirm password") });
  await registration.getByLabel("Email").fill(email);
  await registration.getByLabel("Password", { exact: true }).fill(password);
  await registration.getByLabel("Confirm password").fill(password);
  await registration.getByRole("button", { name: "Create account" }).click();
  await expect(
    page.getByRole("region", { name: "Access Atlas" }).getByRole("status"),
  ).toContainText("Check your email");

  await expect
    .poll(() => latestVerificationMessage(request), { timeout: 10_000 })
    .not.toBeUndefined();
  const message = await latestVerificationMessage(request);
  const verificationUrl = message?.Text.match(/https?:\/\/[^\s]+\/verify-email#token=[^\s]+/)?.[0];
  if (verificationUrl === undefined) {
    throw new Error("Verification email did not contain the capability URL.");
  }
  await page.goto(verificationUrl);
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  await page.getByRole("link", { name: "Continue to sign in" }).click();

  const login = page.locator("form").filter({ has: page.getByRole("button", { name: "Sign in" }) });
  await login.getByLabel("Email").fill(email);
  await login.getByLabel("Password").fill(password);
  await login.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Authenticated as")).toBeVisible();
}

test("shows a durable financial notification and preserves its read receipt", async ({
  page,
  request,
}) => {
  await registerVerifyAndSignIn(page, request);

  await page.locator("#financial-asset").selectOption("USD");
  await page.getByRole("button", { name: "Open USD wallet" }).click();
  await expect(page.getByLabel("USD balance")).toBeVisible();
  await page.locator("#deposit-amount").fill("250");
  await page.getByRole("button", { name: "Add simulated funds" }).click();
  await expect(page.getByText("Simulated funds were credited.")).toBeVisible();

  await page.getByRole("button", { name: /^Notifications/ }).click();
  const inbox = page.getByRole("dialog", { name: "Notifications" });
  await expect(inbox).toBeVisible();
  await inbox.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("button", { name: "Notifications, 1 unread" })).toBeVisible();
  await expect(inbox.getByText("Deposit credited", { exact: true })).toBeVisible();
  await expect(inbox.getByText("250 USD is available.")).toBeVisible();

  await inbox.getByRole("button", { name: "Mark read: Deposit credited" }).click();
  await expect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
  await expect(inbox.getByText(/^Read /)).toBeVisible();

  await page.reload();
  const reloadedTrigger = page.getByRole("button", { name: "Notifications", exact: true });
  await expect(reloadedTrigger).toBeVisible();
  await reloadedTrigger.click();
  const reloadedInbox = page.getByRole("dialog", { name: "Notifications" });
  await expect(reloadedInbox.getByText("All caught up")).toBeVisible();
  await expect(reloadedInbox.getByText("Deposit credited", { exact: true })).toBeVisible();
  await expect(reloadedInbox.getByText(/^Read /)).toBeVisible();
});
