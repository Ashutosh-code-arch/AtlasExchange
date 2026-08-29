import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test, type APIRequestContext } from "@playwright/test";

interface MailpitAddress {
  readonly Address: string;
}

interface MailpitMessage {
  readonly Text: string;
  readonly To: readonly MailpitAddress[];
}

const execFileAsync = promisify(execFile);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing E2E environment variable: ${name}`);
  }
  return value;
}

async function runPostgres(sql: string): Promise<string> {
  const { stdout } = await execFileAsync("docker", [
    "compose",
    "-p",
    requiredEnvironment("ATLAS_E2E_COMPOSE_PROJECT"),
    "-f",
    requiredEnvironment("ATLAS_E2E_COMPOSE_FILE"),
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "atlas_e2e",
    "-d",
    requiredEnvironment("ATLAS_E2E_DATABASE_NAME"),
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
    "-c",
    sql,
  ]);
  return stdout;
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

test("registers, moves simulated funds, and manages an exact identity", async ({
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

  const portfolio = page.getByRole("region", { name: "Know what you hold" });
  await portfolio.getByRole("button", { name: "Refresh portfolio" }).click();
  await expect(portfolio.getByText("Valued subtotal")).toBeVisible();
  await expect(portfolio.getByText("Incomplete valuation")).toBeVisible();
  await expect(
    portfolio.getByText(/BTC excluded because no accepted reference price/i),
  ).toBeVisible();
  const bitcoinPosition = portfolio.getByRole("row").filter({ hasText: "Bitcoin" });
  await expect(bitcoinPosition).toContainText("0.75");
  await expect(bitcoinPosition).toContainText("No committed price");

  const administrationTargetId = "00000000-0000-4000-8000-000000000954";
  const administrationTargetEmail = "administration-target@atlas.test";
  await runPostgres(`
    INSERT INTO identity.user_roles (user_id, role_code)
    SELECT id, 'admin'
    FROM identity.users
    WHERE normalized_email = '${email}'
    ON CONFLICT DO NOTHING;

    INSERT INTO identity.users (id, display_email, normalized_email, state)
    VALUES (
      '${administrationTargetId}',
      '${administrationTargetEmail}',
      '${administrationTargetEmail}',
      'active'
    );

    INSERT INTO identity.user_roles (user_id, role_code)
    VALUES ('${administrationTargetId}', 'user');
  `);
  await page.reload();

  await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
  const administration = page.getByRole("region", { name: "Administration console" });
  await administration.getByLabel("Exact user ID").fill(administrationTargetId);
  await administration.getByRole("button", { name: "Find user" }).click();
  await expect(administration.getByText(administrationTargetEmail)).toBeVisible();
  await expect(administration.getByText("active", { exact: true })).toBeVisible();
  await expect(administration.getByText("user", { exact: true })).toBeVisible();

  await administration.getByLabel("Reviewed reason").nth(1).fill("Approved E2E operational duty.");
  await administration.getByRole("button", { name: "Confirm admin grant" }).click();
  await expect(administration.getByText("user · admin")).toBeVisible();
  await expect(administration.getByRole("status")).toContainText("target sessions were revoked");

  await administration
    .getByLabel("Reviewed reason")
    .first()
    .fill("Reviewed E2E security response.");
  await administration.getByRole("button", { name: "Confirm suspension" }).click();
  await expect(administration.getByText("suspended", { exact: true })).toBeVisible();
  await expect(administration.getByRole("status")).toContainText("active sessions revoked");

  const auditActions = await runPostgres(`
    SELECT string_agg(action, ',' ORDER BY occurred_at)
    FROM administration.audit_events
    WHERE target_user_id = '${administrationTargetId}';
  `);
  expect(auditActions).toContain("identity.admin_role_granted");
  expect(auditActions).toContain("identity.user_suspended");
});
