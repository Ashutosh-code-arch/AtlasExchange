import { expect, test, type APIRequestContext } from "@playwright/test";

interface MailpitAddress {
  readonly Address: string;
}

interface MailpitMessage {
  readonly Text: string;
  readonly To: readonly MailpitAddress[];
}

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
  if (!response.ok()) {
    return undefined;
  }
  const message = (await response.json()) as MailpitMessage;
  return message.To.some((recipient) => recipient.Address === email) ? message : undefined;
}

test("registers, verifies email, signs in, and moves simulated funds", async ({
  page,
  request,
}) => {
  const email = "browser-journey@atlas.test";
  const password = "Atlas E2E passphrase 2026!";
  const requestFailures: string[] = [];
  page.on("requestfailed", (failedRequest) => {
    requestFailures.push(
      `${failedRequest.method()} ${failedRequest.url()}: ${failedRequest.failure()?.errorText ?? "unknown failure"}`,
    );
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Access Atlas" })).toBeVisible();
  const createAccount = page.getByRole("button", { name: "Create account" });
  const retrySessionCheck = page.getByRole("button", { name: "Retry session check" });
  await expect(createAccount.or(retrySessionCheck)).toBeVisible();
  if (await retrySessionCheck.isVisible()) {
    throw new Error(`Identity session bootstrap failed: ${requestFailures.join(" | ")}`);
  }
  await createAccount.click();

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
  if (message === undefined) {
    throw new Error("Mailpit did not retain the verification message.");
  }
  const verificationUrl = message.Text.match(/https?:\/\/[^\s]+\/verify-email#token=[^\s]+/)?.[0];
  if (verificationUrl === undefined) {
    throw new Error("Verification email did not contain the expected capability URL.");
  }

  await page.goto(verificationUrl);
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  await page.getByRole("link", { name: "Continue to sign in" }).click();

  const signIn = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Sign in" }) });
  await signIn.getByLabel("Email").fill(email);
  await signIn.getByLabel("Password").fill(password);
  await signIn.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Authenticated as")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Move simulated value" })).toBeVisible();
  await page.getByRole("button", { name: "Open BTC wallet" }).click();
  await expect(
    page.getByLabel("BTC balance").getByText("0", { exact: true }).first(),
  ).toBeVisible();

  await page.locator("#deposit-amount").fill("1.25");
  await page.getByRole("button", { name: "Add simulated funds" }).click();
  await expect(page.getByText("Simulated funds were credited.")).toBeVisible();
  await expect(
    page.getByLabel("BTC balance").getByText("1.25", { exact: true }).first(),
  ).toBeVisible();

  await page.locator("#withdrawal-amount").fill("0.5");
  await page.getByRole("button", { name: "Complete simulated withdrawal" }).click();
  await expect(
    page.getByText("Simulated withdrawal completed. No external asset was transferred."),
  ).toBeVisible();
  await expect(
    page.getByLabel("BTC balance").getByText("0.75", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "0.5 BTC" })).toBeVisible();
  await expect(page.getByText("completed", { exact: true })).toBeVisible();
  await expect(
    page.getByText("No destination is collected because no external transfer occurs."),
  ).toBeVisible();
});
