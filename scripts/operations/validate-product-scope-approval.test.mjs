import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  dataCategories,
  deploymentControlRequirements,
  disclosureRequirements,
  parseProductScopeApprovalPath,
  validateProductScopeApproval,
} from "./validate-product-scope-approval.mjs";

const now = Date.parse("2026-08-31T15:00:00.000Z");

function createApproval({ outcome = "approved" } = {}) {
  const blocked = outcome === "blocked";
  return {
    schemaVersion: 1,
    approvalId: "scope-2026-08-31-invited-release",
    environment: "staging",
    release: {
      version: "1.2.3",
      revision: "a".repeat(40),
    },
    scope: {
      purpose: "centralized-exchange-learning-platform",
      audience: "invited-testers",
      accessModel: "deny-by-default",
      valueModel: "simulated-only",
      realAssetsAccepted: false,
      financialReturnsPromised: false,
      financialAdviceProvided: false,
    },
    deploymentControls: deploymentControlRequirements.map((requirement, index) => ({
      id: requirement.id,
      requiredSetting: requirement.requiredSetting,
      status: blocked && index === 0 ? "blocked" : "verified",
      notes:
        blocked && index === 0 ? "Staging evidence has not been collected." : "Control verified.",
      evidence: blocked && index === 0 ? [] : [`evidence://product-scope/${requirement.id}`],
    })),
    disclosures: disclosureRequirements.map((id, index) => ({
      id,
      status: blocked && index === 0 ? "blocked" : "approved",
      owner: blocked && index === 0 ? "replace-with-owner" : "product-owner",
      notes: blocked && index === 0 ? "Disclosure review is not complete." : "Disclosure approved.",
      evidence: blocked && index === 0 ? [] : [`evidence://product-scope/${id}`],
    })),
    dataHandling: {
      status: blocked ? "blocked" : "approved",
      owner: blocked ? "replace-with-privacy-owner" : "privacy-owner",
      categories: [...dataCategories],
      references: {
        privacyNotice: blocked ? "not-selected" : "policy://privacy-notice",
        retentionPolicy: blocked ? "not-selected" : "policy://data-retention",
        deletionProcedure: blocked ? "not-selected" : "runbook://account-deletion",
        subprocessorReview: blocked ? "not-selected" : "review://subprocessors",
      },
      notes: blocked ? "Data-handling review is not complete." : "Data handling approved.",
      evidence: blocked ? [] : ["evidence://product-scope/privacy-review"],
    },
    support: {
      status: blocked ? "blocked" : "approved",
      owner: blocked ? "replace-with-support-owner" : "support-owner",
      contactPath: blocked ? "not-configured" : "support://invited-testers",
      incidentEscalation: blocked ? "not-configured" : "runbook://incident-escalation",
      tested: !blocked,
      notes: blocked ? "Support path is not configured." : "Support path delivered successfully.",
      evidence: blocked ? [] : ["evidence://product-scope/support-test"],
    },
    decision: {
      outcome,
      decidedAt: "2026-08-31T13:00:00.000Z",
      decidedBy: blocked ? "replace-with-accountable-owner" : "accountable-owner",
      reason: blocked
        ? "Required reviews and deployment evidence are incomplete."
        : "The invited simulated-only product scope is approved.",
    },
  };
}

describe("product scope approval validation", () => {
  it("keeps the committed example valid, blocked, and ineligible", () => {
    const example = JSON.parse(
      readFileSync(
        new URL("../../docs/engineering/product-scope-approval.example.json", import.meta.url),
        "utf8",
      ),
    );

    const report = validateProductScopeApproval(example, { now });
    assert.equal(report.outcome, "blocked");
    assert.equal(report.readinessEligible, false);
    assert.ok(report.blockingItems > 0);
  });

  it("accepts a complete current approval as readiness-eligible", () => {
    const report = validateProductScopeApproval(createApproval(), { now });

    assert.equal(report.outcome, "approved");
    assert.equal(report.readinessEligible, true);
    assert.equal(report.blockingItems, 0);
    assert.equal(report.expiresAt, "2026-09-30T13:00:00.000Z");
  });

  it("accepts visible blocked requirements without granting eligibility", () => {
    const report = validateProductScopeApproval(createApproval({ outcome: "blocked" }), { now });

    assert.equal(report.outcome, "blocked");
    assert.equal(report.readinessEligible, false);
    assert.equal(report.blockingItems, 4);
  });

  it("expires approval after the 30-day readiness window", () => {
    const report = validateProductScopeApproval(createApproval(), {
      now: Date.parse("2026-09-30T13:00:00.000Z"),
    });

    assert.equal(report.outcome, "approved");
    assert.equal(report.readinessEligible, false);
  });

  it("accepts direct Node and pnpm-forwarded record paths", () => {
    assert.equal(parseProductScopeApprovalPath(["record.json"]), "record.json");
    assert.equal(parseProductScopeApprovalPath(["--", "record.json"]), "record.json");
    assert.throws(() => parseProductScopeApprovalPath([]), /Usage/);
    assert.throws(() => parseProductScopeApprovalPath(["one.json", "two.json"]), /Usage/);
  });

  it("rejects broader or ambiguous product scope", () => {
    for (const [field, value] of [
      ["audience", "public"],
      ["valueModel", "mixed"],
      ["realAssetsAccepted", true],
      ["financialAdviceProvided", true],
    ]) {
      const record = createApproval();
      record.scope[field] = value;
      assert.throws(
        () => validateProductScopeApproval(record, { now }),
        new RegExp(`scope.${field}`),
      );
    }
  });

  it("requires every exact deployment control and setting", () => {
    const missing = createApproval();
    missing.deploymentControls.pop();
    assert.throws(
      () => validateProductScopeApproval(missing, { now }),
      /Missing deployment controls/,
    );

    const duplicate = createApproval();
    duplicate.deploymentControls[1].id = duplicate.deploymentControls[0].id;
    assert.throws(
      () => validateProductScopeApproval(duplicate, { now }),
      /Duplicate deployment control/,
    );

    const unsafeSetting = createApproval();
    unsafeSetting.deploymentControls[0].requiredSetting = "SIMULATED_FUNDING_ENABLED=true";
    assert.throws(
      () => validateProductScopeApproval(unsafeSetting, { now }),
      /requiredSetting must equal/,
    );
  });

  it("requires complete disclosure and privacy review evidence", () => {
    const missingDisclosure = createApproval();
    missingDisclosure.disclosures.pop();
    assert.throws(
      () => validateProductScopeApproval(missingDisclosure, { now }),
      /Missing disclosure/,
    );

    const missingCategory = createApproval();
    missingCategory.dataHandling.categories.pop();
    assert.throws(
      () => validateProductScopeApproval(missingCategory, { now }),
      /exactly the required data categories/,
    );

    const placeholderPolicy = createApproval();
    placeholderPolicy.dataHandling.references.privacyNotice = "not-selected";
    assert.throws(() => validateProductScopeApproval(placeholderPolicy, { now }), /placeholder/);
  });

  it("requires tested support and rejects false approval", () => {
    const untestedSupport = createApproval();
    untestedSupport.support.tested = false;
    assert.throws(
      () => validateProductScopeApproval(untestedSupport, { now }),
      /tested contact path/,
    );

    const blockedControl = createApproval();
    blockedControl.deploymentControls[0].status = "blocked";
    blockedControl.deploymentControls[0].evidence = [];
    assert.throws(
      () => validateProductScopeApproval(blockedControl, { now }),
      /cannot contain blocked/,
    );

    const unsupportedNoGo = createApproval();
    unsupportedNoGo.decision.outcome = "blocked";
    assert.throws(
      () => validateProductScopeApproval(unsupportedNoGo, { now }),
      /at least one blocked/,
    );
  });

  it("rejects placeholder release identity and future decisions", () => {
    const placeholder = createApproval();
    placeholder.release.revision = "0".repeat(40);
    assert.throws(
      () => validateProductScopeApproval(placeholder, { now }),
      /placeholder release revision/,
    );

    const future = createApproval();
    future.decision.decidedAt = "2026-08-31T16:00:00.000Z";
    assert.throws(() => validateProductScopeApproval(future, { now }), /cannot be in the future/);
  });

  it("rejects unknown fields and likely secret material", () => {
    const unknown = createApproval();
    unknown.legalOpinion = "unexpected";
    assert.throws(() => validateProductScopeApproval(unknown, { now }), /must contain exactly/);

    const secret = createApproval();
    secret.support.notes = "Authorization: Bearer super-sensitive-value";
    assert.throws(() => validateProductScopeApproval(secret, { now }), /secret material/);
  });
});
