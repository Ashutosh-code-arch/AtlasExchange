import { Linter } from "eslint";
import { resolve } from "node:path";

import { atlasBoundaries } from "./atlas-boundaries.js";

const linter = new Linter();
const config = {
  files: ["**/*.{js,ts,tsx}"],
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: { atlas: atlasBoundaries },
  rules: { "atlas/enforce-boundaries": "error" },
};

const cases = [
  {
    name: "backend module internals",
    filename: resolve("apps/api/src/modules/orders/application/place-order.ts"),
    source: 'import "../../wallet/domain/wallet.js";',
  },
  {
    name: "frontend feature internals",
    filename: resolve("apps/web/src/features/orders/components/order-form.ts"),
    source: 'import "../../portfolio/components/allocation.js";',
  },
  {
    name: "domain to infrastructure",
    filename: resolve("apps/api/src/modules/wallet/domain/wallet.ts"),
    source: 'import "../infrastructure/wallet-repository.js";',
  },
  {
    name: "application to platform",
    filename: resolve("apps/api/src/modules/wallet/application/create-wallet.ts"),
    source: 'import "../../../platform/database/database.js";',
  },
  {
    name: "app composition to backend module internals",
    filename: resolve("apps/api/src/server.ts"),
    source: 'export { Wallet } from "./modules/wallet/domain/wallet.js";',
  },
  {
    name: "page composition to frontend feature internals",
    filename: resolve("apps/web/src/pages/portfolio/page.ts"),
    source: 'void import("../../features/portfolio/components/allocation.js");',
  },
];

for (const testCase of cases) {
  const messages = linter.verify(testCase.source, [config], { filename: testCase.filename });
  if (!messages.some((message) => message.ruleId === "atlas/enforce-boundaries")) {
    throw new Error(`Boundary verification did not reject ${testCase.name}.`);
  }
}

const publicApiMessages = linter.verify('import "../../wallet/index.js";', [config], {
  filename: resolve("apps/api/src/modules/orders/application/place-order.ts"),
});

if (publicApiMessages.length > 0) {
  throw new Error("Boundary verification rejected a backend module public index import.");
}
