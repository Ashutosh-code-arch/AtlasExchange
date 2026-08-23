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

test("registers, verifies the captured email, and signs in", async ({ page, request }) => {
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
});
