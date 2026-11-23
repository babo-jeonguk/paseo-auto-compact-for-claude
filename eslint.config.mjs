import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

// TypeScript files get type information from tsconfig.json. Other formats
// (.mjs and the .mts fixture generator) are linted without it.
const typed = ["**/*.ts", "**/*.tsx"];

// Unit tests run in one process with fakes; the simulation and E2E suites
// drive real processes and keep real time. Test support modules are held to
// the unit-test rule too, except the one that owns the failure bound.
const unitTests = ["server/*.test.ts", "scripts/*.test.ts", "tests/*.test.mjs", "tests/support/**"];
const failureBound = "tests/support/failure-bound.ts";
const tests = ["**/*.test.ts", "**/*.test.mjs", "tests/**"];
const product = ["index.server.ts", "index.client.tsx", "client/**", "server/**", "shared/**", "scripts/**"];

const realTime = 'Unit tests start no real timer with a delay. Advance the injected clock or mock.timers, wait on ' +
  'observable state such as a fake being called, and bound a wait that may never end with settledWithin from ' +
  'tests/support/failure-bound.ts (CODING_STANDARDS.md "Tests").';
const namedTiming = 'A timer or deadline argument is a named constant with an _MS suffix and a comment ' +
  'that says why it has that value (CODING_STANDARDS.md "Named timings").';
const timer = "/^(setTimeout|setInterval)$/";
// The delay argument when a number is written into it, alone or inside an
// expression; 0 (the next turn, or a lower bound) is not a duration. A function
// in that position is a callback; `every` is a timer only on a clock.
const number = "Literal[raw=/^\\.?[0-9]/]:not([value=0])";
const literal = (call, position) =>
  `${call} > :nth-child(${position}):not(:function):matches(${number}, :has(${number}))`;

export const projectRules = [
  {
    files: unitTests,
    ignores: [failureBound],
    rules: {
      "no-restricted-syntax": ["error",
        {
          // Any delay but 0 (the next turn), whatever the callback does.
          selector: `CallExpression:matches([callee.name=${timer}], [callee.object.name='globalThis'][callee.property.name=${timer}])` +
            "[arguments.length>1]:not([arguments.1.value=0])",
          message: realTime,
        },
        {
          // Everything these modules offer but setImmediate waits in real time.
          selector: "ImportDeclaration[source.value=/^(node:)?timers(\\/promises)?$/] > " +
            ":matches(ImportSpecifier:not([imported.name='setImmediate']), ImportNamespaceSpecifier, ImportDefaultSpecifier)",
          message: realTime,
        },
      ],
    },
  },
  {
    files: product,
    ignores: tests,
    rules: {
      "no-restricted-syntax": ["error", {
        selector: [
          literal(`CallExpression:matches([callee.name=${timer}], [callee.property.name=${timer}], [callee.name='bounded'])`, 2),
          literal("CallExpression[callee.property.name='every']:matches([callee.object.name='clock'], " +
            "[callee.object.property.name='clock'])", 1),
          literal("CallExpression[callee.object.name='AbortSignal'][callee.property.name='timeout']", 1),
        ].join(", "),
        message: namedTiming,
      }],
    },
  },
];

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
  ...projectRules,
]);
