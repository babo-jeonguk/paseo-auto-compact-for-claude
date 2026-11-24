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
// the unit-test rule too.
const unitTests = ["server/*.test.ts", "scripts/*.test.ts", "tests/*.test.mjs", "tests/support/**"];
const testSupport = ["tests/support/**"];
const tests = ["**/*.test.ts", "**/*.test.mjs", "tests/**"];
const product = ["index.server.ts", "index.client.tsx", "client/**", "server/**", "shared/**", "scripts/**"];
// Code the unit tests run with fakes. The plugin's entry point, the client and
// the scripts run on real time.
const server = ["server/**", "shared/**"];

const realTime = 'Unit tests start no real timer with a delay. Advance the injected clock or the test\'s mock timers ' +
  'and wait on observable state such as a fake being called; the test runner bounds every test, so a wait needs ' +
  'no timer of its own (CODING_STANDARDS.md "Tests").';
const countedWait = 'A unit test waits for a condition through a signal, not by counting loop turns: wait on the fake\'s ' +
  'change (changes() in tests/support/changes.ts) or on the promise of the step itself; the test runner bounds the ' +
  'wait (CODING_STANDARDS.md "Tests").';
const contextMock = 'A unit test mocks through its test context (t.mock), which the runner restores even when the ' +
  'test stops at its bound and its finally never runs; a mock on the shared tracker would outlive it ' +
  '(CODING_STANDARDS.md "Tests").';
const cleanupInFinally = 'A test stopped at the runner\'s bound never reaches its finally, so it registers the cleanup ' +
  'of what would outlive it (a timer, process, server or temporary folder) with t.after() right after acquiring it; ' +
  'the runner still runs those hooks. A finally that must still wait says why it is safe in a disable comment ' +
  '(CODING_STANDARDS.md "Tests").';
const turnWait = 'A unit test does not wait for an event-loop turn: work outside its fakes can still act after one. ' +
  'Wait on the promise of the call, on a fake\'s change, or with drained() from tests/support/drained.ts, which ' +
  'resolves once nothing is left to run and fails if real work is still pending (CODING_STANDARDS.md "Tests").';
const serverRealTime = 'Server code waits on time only through the injected timers (Timers), whose one real ' +
  'implementation is systemTimers in server/deadline.ts, so a unit test drives every wait and can tell when ' +
  'processing has ended (CODING_STANDARDS.md "Decisions apart from effects").';
const namedTiming = 'A timer or deadline argument is a named constant with an _MS suffix and a comment ' +
  'that says why it has that value (CODING_STANDARDS.md "Named timings").';
const timer = "/^(setTimeout|setInterval)$/";
// A call of one of `names` by name or through the global object with a written
// key. One reached through another name or a key built at run time is left to
// review: a selector cannot tell what it names.
const globalCall = (names) => `CallExpression:matches([callee.name=${names}], ` +
  `[callee.object.name=/^global(This)?$/]:matches([callee.computed=false][callee.property.name=${names}], ` +
  `[callee.property.value=${names}], ` +
  `[callee.property.expressions.length=0][callee.property.quasis.0.value.cooked=${names}]))`;
const timersModule = "/^(node:)?timers(\\/promises)?$/";
// The same modules loaded at run time, named by a string or a template without
// interpolation.
const timersImport = `ImportExpression:matches([source.value=${timersModule}], ` +
  `[source.expressions.length=0][source.quasis.0.value.cooked=${timersModule}])`;
// The delay argument when a number is written into it, alone or inside an
// expression; 0 (the next turn, or a lower bound) is not a duration. A function
// in that position is a callback; `every` is a timer only on a clock.
const number = "Literal[raw=/^\\.?[0-9]/]:not([value=0])";
const literal = (call, position) =>
  `${call} > :nth-child(${position}):not(:function):matches(${number}, :has(${number}))`;

// Rules for every unit test and its support modules.
const unitTestRules = [
        {
          // Any delay but 0 (the next turn), whatever the callback does.
          selector: `${globalCall(timer)}[arguments.length>1]:not([arguments.1.value=0])`,
          message: realTime,
        },
        {
          // Everything these modules offer but setImmediate waits in real time.
          selector: `ImportDeclaration[source.value=${timersModule}] > ` +
            ":matches(ImportSpecifier:not([imported.name='setImmediate'], [imported.value='setImmediate']), " +
            "ImportNamespaceSpecifier, ImportDefaultSpecifier)",
          message: realTime,
        },
        {
          // A counted loop that awaits and also stops on a condition: a wait
          // for state that gives up after a number of turns. A fixed number of
          // steps (advancing a clock N times) checks no condition and passes.
          // A while loop with its own counter is left to review.
          selector: "ForStatement:has(AwaitExpression):matches([test.type='LogicalExpression'], " +
            ":has(BreakStatement), :has(ReturnStatement))",
          message: countedWait,
        },
        {
          // The shared tracker's mocks that patch state other tests also see.
          // mock.fn() makes a standalone function and patches nothing.
          selector: "MemberExpression[object.name='mock'][property.name=/^(timers|method|getter|setter|property|module)$/]",
          message: contextMock,
        },
        {
          selector: timersImport,
          message: realTime,
        },
        {
          // A wait inside finally: it runs only when the test body ends on its
          // own. Releasing a held step without waiting is a test step and passes.
          selector: "TryStatement > BlockStatement.finalizer :matches(AwaitExpression, ForOfStatement[await=true])",
          message: cleanupInFinally,
        },
];
// A wait for one event-loop turn: an immediate, a timer or interval with no
// delay, or setImmediate from the timer modules. Only tests/support/drained.ts, which checks that
// nothing real is pending after its turn, may take one.
const turnWaitRules = [
  {
    selector: `${globalCall("/^setImmediate$/")}, ` +
      `${globalCall("/^(setTimeout|setInterval)$/")}:matches([arguments.length<2], [arguments.1.value=0]), ` +
      `ImportDeclaration[source.value=${timersModule}] > ImportSpecifier:matches([imported.name='setImmediate'], ` +
      "[imported.value='setImmediate'])",
    message: turnWait,
  },
];
const namedTimingRules = [{
  selector: [
    literal(`CallExpression:matches([callee.name=${timer}], [callee.property.name=${timer}], [callee.name='bounded'])`, 2),
    literal("CallExpression[callee.property.name='every']:matches([callee.object.name='clock'], " +
      "[callee.object.property.name='clock'])", 1),
    literal("CallExpression[callee.object.name='AbortSignal'][callee.property.name='timeout']", 1),
  ].join(", "),
  message: namedTiming,
}];
// The key of the member expression at `path` ("" for the node itself, or
// "callee." and "object." for one below it), written as a name, a string or a
// template without interpolation.
const writtenKey = (name, path = "") => `:matches([${path}computed=false][${path}property.name='${name}'], ` +
  `[${path}property.value='${name}'], ` +
  `[${path}property.expressions.length=0][${path}property.quasis.0.value.cooked='${name}'])`;
// Real time reached in server code: a global timer, a timeout signal (also
// through the global object), or the timer modules imported, re-exported,
// required or loaded as a built-in by a written name.
const serverRealTimeRules = [{
  selector: `${globalCall("/^(setTimeout|setInterval|setImmediate)$/")}, ` +
    `CallExpression > MemberExpression.callee${writtenKey("timeout")}:matches([object.name='AbortSignal'], ` +
    `[object.object.name=/^global(This)?$/]${writtenKey("AbortSignal", "object.")}), ` +
    `:matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration)[source.value=${timersModule}], ` +
    `${timersImport}, ` +
    `CallExpression:matches([callee.name='require'], ` +
    `[callee.object.name='process']${writtenKey("getBuiltinModule", "callee.")}):matches(` +
    `[arguments.0.value=${timersModule}], ` +
    `[arguments.0.expressions.length=0][arguments.0.quasis.0.value.cooked=${timersModule}])`,
  message: serverRealTime,
}];

// A later entry's no-restricted-syntax replaces an earlier one's for the same
// file, so each entry lists every selector that applies to its files.
export const projectRules = [
  {
    files: unitTests,
    ignores: testSupport,
    rules: { "no-restricted-syntax": ["error", ...unitTestRules, ...turnWaitRules] },
  },
  {
    files: testSupport,
    rules: { "no-restricted-syntax": ["error", ...unitTestRules] },
  },
  {
    files: product,
    ignores: [...tests, ...server],
    rules: { "no-restricted-syntax": ["error", ...namedTimingRules] },
  },
  {
    files: server,
    ignores: tests,
    rules: { "no-restricted-syntax": ["error", ...namedTimingRules, ...serverRealTimeRules] },
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
