import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

// TypeScript files get type information from tsconfig.json. Other formats
// (.mjs and the .mts fixture generator) are linted without it.
const typed = ["**/*.ts", "**/*.tsx"];

export default defineConfig([
  globalIgnores([
    "**/node_modules/",
    "test-results/",
    // Generated from server/observer-source.mjs, which is linted instead.
    "server/observer-assets.generated.ts",
  ]),
  {
    // A disable comment says why, and one that no longer suppresses anything
    // is an error so it cannot outlive its reason.
    linterOptions: { reportUnusedDisableDirectives: "error", reportUnusedInlineConfigs: "error" },
  },
  comments.recommended,
  { rules: { "@eslint-community/eslint-comments/require-description": "error" } },
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: globals.node } },
  {
    files: typed,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // node:test runs and awaits the promise `test` and `describe` return.
      "@typescript-eslint/no-floating-promises": ["error", {
        allowForKnownSafeCalls: [
          { from: "package", package: "node:test", name: ["test", "describe", "it", "suite"] },
        ],
      }],
      // Forwarding another promise's rejection passes on whatever it rejected with.
      "@typescript-eslint/prefer-promise-reject-errors": ["error", { allowThrowingAny: true, allowThrowingUnknown: true }],
      // Interfaces here declare callbacks in method syntax and the objects that
      // implement them are closures, so a detached method never loses `this`.
      "@typescript-eslint/unbound-method": "off",
      // `async` on a fake or a wrapper turns a synchronous throw into a
      // rejection, which is the contract the caller handles.
      "@typescript-eslint/require-await": "off",
      // Stored and remote data is validated with zod schemas at the boundary
      // (CODING_STANDARDS.md "Durable state stays compatible"); the transcript
      // scan checks each field it reads. Flagging every `any` from JSON.parse
      // adds casts, not checks.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    rules: {
      // A leading underscore marks a parameter kept for its position in a signature.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // A `let` that a closure reads before its single assignment stays a
      // `let`: as a `const` that read would throw instead of seeing undefined.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // A generator that returns without yielding fakes a stream with no events.
    files: ["**/*.test.ts", "**/*.test.mjs"],
    rules: { "require-yield": "off" },
  },
  {
    // These suites pass functions to the browser under test (`page.evaluate`).
    files: ["tests/e2e/**", "tests/simulation/**"],
    languageOptions: { globals: { window: "readonly" } },
  },
]);
