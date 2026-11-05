// SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
// SPDX-License-Identifier: MIT
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{js,jsx,ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Rules aligned with the team's `ui` repo.
      eqeqeq: "error",
      "default-case": "error",
      "default-case-last": "error",
      // API JSON fields are snake_case (max_nodes, relation_properties, ...).
      camelcase: ["error", { properties: "never", ignoreDestructuring: true }],
      "max-lines": ["error", 500],
      "max-lines-per-function": ["error", 500],
      // Unused vars are warnings, `_`-prefixed names are ignored. Unused imports
      // are errors already: tsc runs with noUnusedLocals in the check gate.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  {
    // shadcn/ui components (CLI-generated, regenerated on `shadcn add/update`):
    // they export variant helpers (cva) alongside components, which the
    // react-refresh rule cannot classify as constants.
    files: ["src/components/ui/**"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    // Over the 500-line limit of the team's `ui` rules. Not refactored here: the
    // owner decides whether to split these files or keep the exception.
    files: [
      "src/engine/engine.ts", // ~966 lines
      "src/engine/gpu-graph.ts", // ~879 lines
      "src/components/GraphView.tsx", // ~559 lines, one component
    ],
    rules: {
      "max-lines": "off",
      "max-lines-per-function": "off",
    },
  }
);
