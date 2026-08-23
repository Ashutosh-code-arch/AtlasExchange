import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

import { atlasBoundaries } from "./scripts/eslint/atlas-boundaries.js";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/node_modules/**",
      ".husky/**",
      "docs/**",
      "[0-9][0-9]_*.md",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      atlas: atlasBoundaries,
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "atlas/enforce-boundaries": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/apps/*/src/**", "../../../apps/*/src/**"],
              message: "Applications may communicate only through public workspace contracts.",
            },
            {
              group: ["**/packages/contracts/src/**", "../../../packages/contracts/src/**"],
              message: "Consume @atlas/contracts through its public package export.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/api/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.flat["recommended-latest"].rules,
      "react-refresh/only-export-components": ["error", { allowConstantExport: true }],
    },
  },
  {
    files: ["packages/contracts/**/*.{ts,tsx}"],
    languageOptions: { globals: {} },
  },
  {
    files: ["tests/e2e/**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.config.{js,ts}", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  prettier,
);
