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

const realTime = 'Unit tests start no real timer with a delay. Move the injected timers on (fakeTimers() in ' +
  'tests/support/timers.ts) and wait on observable state such as a fake being called; the test runner bounds every test, so a wait needs ' +
  'no timer of its own (CODING_STANDARDS.md "Tests").';
const countedWait = 'A unit test waits for a condition through a signal, not by counting loop turns: wait on the fake\'s ' +
  'change (changes() in tests/support/changes.ts) or on the promise of the step itself; the test runner bounds the ' +
  'wait (CODING_STANDARDS.md "Tests").';
const mockTimers = 'Unit tests move product time only through fakeTimers() in tests/support/timers.ts, the one ' +
  'fake of the injected Timers that product code waits on; Node\'s mock timers replace the global timers with ' +
  'other semantics, such as when a due callback runs (CODING_STANDARDS.md "Tests").';
const ownTimerFake = 'A unit test fakes the injected timers only with fakeTimers() in tests/support/timers.ts, ' +
  'which also gives the time they keep (now(), tick(), jump()). A fake written in a test has its own semantics, such ' +
  'as when a due callback runs, which the next test could copy; a fake the shared one cannot express belongs in ' +
  'tests/support/timers.ts with its tests (CODING_STANDARDS.md "Tests").';
const contextMock = 'A unit test mocks through its test context (t.mock), which the runner restores even when the ' +
  'test stops at its bound and its finally never runs; a mock on the shared tracker would outlive it ' +
  '(CODING_STANDARDS.md "Tests").';
const cleanupInFinally = 'A test stopped at the runner\'s bound never reaches its finally, so what acquires something ' +
  'that would outlive the test (a timer, process, server or temporary folder) registers its release with the test\'s ' +
  'cleanup scope (tests/support/scope.ts) as it acquires it; the runner still runs the scope\'s hook. A finally ' +
  'never waits: what must happen at the end of a test, however it ends, is a release registered with the cleanup ' +
  'scope (CODING_STANDARDS.md "Tests").';
const temporaryFolder = 'A unit test creates a temporary folder through its cleanup scope (folder() in ' +
  'tests/support/scope.ts), which registers the removal in the same call, so no step between creating the folder ' +
  'and registering its removal can leak it (CODING_STANDARDS.md "Tests").';
const childProcess = 'A unit test starts a child process through its cleanup scope (spawn() or run() in ' +
  'tests/support/scope.ts), which gives the child a temp directory inside a folder the test owns and ends its whole ' +
  'process tree when the test ends, so nothing it starts or creates outlives the test (CODING_STANDARDS.md "Tests").';
const testHook = 'A unit test registers cleanup with its cleanup scope (defer() in tests/support/scope.ts), whose one ' +
  'hook releases in reverse order of acquisition, runs every release and reports each failure. Hooks registered ' +
  'one by one run in registration order and stop at the first that throws (CODING_STANDARDS.md "Tests").';
const turnWait = 'A unit test does not wait for a bare event-loop turn: work can still act after one. Wait on the ' +
  'promise of the call, on a fake\'s change, or with drained() from tests/support/drained.ts, which takes the turn ' +
  'and then fails if Node still lists a real timer, immediate or I/O request as pending (CODING_STANDARDS.md "Tests").';
const serverRealTime = 'Server code waits on time only through the injected timers (Timers), whose one real ' +
  'implementation is systemTimers in server/deadline.ts, so a unit test drives every wait and can tell when ' +
  'processing has ended (CODING_STANDARDS.md "Decisions apart from effects").';
const namedTiming = 'A timer or deadline argument is a named constant with an _MS suffix and a comment ' +
  'that says why it has that value (CODING_STANDARDS.md "Named timings").';
const timer = "/^(setTimeout|setInterval)$/";
// A call of one of `names` (with or without `new`) by name or through the
// global object with a written key. One reached through another name or a key
// built at run time is left to review: a selector cannot tell what it names.
const globalCall = (names) => `:matches(CallExpression, NewExpression):matches([callee.name=${names}], ` +
  `[callee.object.name=/^global(This)?$/]:matches([callee.computed=false][callee.property.name=${names}], ` +
  `[callee.property.value=${names}], ` +
  `[callee.property.expressions.length=0][callee.property.quasis.0.value.cooked=${names}]))`;
const timersModule = "/^(node:)?timers(\\/promises)?$/";
// A key at `field` of a node whose `computed` sits beside it (`computed` is at
// `field` with its last step replaced), written as a name, a string or a
// template without interpolation. `key` is an esquery value: a quoted name or a
// regular expression.
const writtenAt = (field, key) => {
  const computed = field.replace(/[^.]*$/, "computed");
  return `:matches([${computed}=false][${field}.name=${key}], [${field}.value=${key}], ` +
    `[${field}.expressions.length=0][${field}.quasis.0.value.cooked=${key}])`;
};
// The key of the member expression at `path` ("" for the node itself, or
// "callee." and "object." for one below it).
const writtenKeyMatching = (key, path = "") => writtenAt(`${path}property`, key);
const writtenKey = (name, path = "") => writtenKeyMatching(`'${name}'`, path);
// The timer modules loaded at run time, named by a string or a template
// without interpolation: import(), require(), or process.getBuiltinModule()
// (also through the global object).
const written = (path, module = timersModule) => `:matches([${path}value=${module}], ` +
  `[${path}expressions.length=0][${path}quasis.0.value.cooked=${module}])`;
// A timeout signal, by name or through the global object with a written key.
const abortTimeout = `CallExpression > MemberExpression.callee${writtenKey("timeout")}:matches([object.name='AbortSignal'], ` +
  `[object.object.name=/^global(This)?$/]${writtenKey("AbortSignal", "object.")})`;
const moduleLoad = (module) => `ImportExpression${written("source.", module)}, ` +
  `CallExpression:matches([callee.name='require'], ` +
  `[callee.type='MemberExpression']${writtenKey("getBuiltinModule", "callee.")}:matches([callee.object.name='process'], ` +
  `[callee.object.object.name=/^global(This)?$/]${writtenKey("process", "callee.object.")}))${written("arguments.0.", module)}`;
const timersLoad = moduleLoad(timersModule);
const childProcessModule = "/^(node:)?child_process$/";
// The delay argument when a number is written into it, alone or inside an
// expression; 0 (the next turn, or a lower bound) is not a duration. A function
// in that position is a callback; `every` is a timer only on a clock.
const number = "Literal[raw=/^\\.?[0-9]/]:not([value=0])";
const literal = (call, position) =>
  `${call} > :nth-child(${position}):not(:function):matches(${number}, :has(${number}))`;

// A real timer with any delay but 0 (the next turn), whatever the callback
// does. setTimeout is its own rule: the cleanup scope's process time limit is
// the one boundary for it.
const delayed = (names) => `${globalCall(names)}[arguments.length>1]:not([arguments.1.value=0])`;
const delayedTimeout = { selector: delayed("/^setTimeout$/"), message: realTime };
// Rules for every unit test and its support modules.
const unitTestRules = [
        delayedTimeout,
        {
          selector: delayed("/^setInterval$/"),
          message: realTime,
        },
        {
          // A timeout signal is a real timer, whatever its delay.
          selector: abortTimeout,
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
          // mock.fn() makes a standalone function and patches nothing. Its
          // timers are a finding of their own outside the support modules.
          selector: "MemberExpression[object.name='mock'][property.name=/^(method|getter|setter|property|module)$/]",
          message: contextMock,
        },
        {
          selector: timersLoad,
          message: realTime,
        },
        {
          // A wait inside finally: it runs only when the test body ends on its
          // own. Releasing a held step without waiting is a test step and passes.
          selector: "TryStatement > BlockStatement.finalizer :matches(AwaitExpression, ForOfStatement[await=true])",
          message: cleanupInFinally,
        },
];
// Node's mock timers on the shared tracker (`mock.timers`) or a test context
// (`t.mock.timers`). Outside the support modules both are a second fake of
// product time; inside them only the shared tracker's outlives the test.
const mockTimersAt = (object) => `MemberExpression${writtenKey("timers")}${object}`;
const sharedTrackerTimers = mockTimersAt("[object.name='mock']");
const mockTimersRules = [{
  selector: `${sharedTrackerTimers}, ${mockTimersAt(`[object.type='MemberExpression']${writtenKey("mock", "object.")}`)}`,
  message: mockTimers,
}];
// A timer fake of a test's own: an object or class that provides both
// setTimeout and clearTimeout under written names. One that spreads the shared
// fake and overrides one of them observes it and passes.
const ownKey = (name) => `:matches(Property, MethodDefinition, PropertyDefinition)${writtenAt("key", `'${name}'`)}`;
const ownTimerFakeRules = [{
  selector: `:matches(ObjectExpression, ClassBody):has(> ${ownKey("setTimeout")}):has(> ${ownKey("clearTimeout")})`,
  message: ownTimerFake,
}];
const sharedMockTimersRules = [{ selector: sharedTrackerTimers, message: contextMock }];
// Cleanup that bypasses the test's scope: a temporary folder made directly,
// whose removal the caller registers only afterwards, a hook of the test
// runner, which runs outside the scope's order, and a child process, whose
// temp files and descendants the test would not own. The support modules are
// exempt: the scope and the programs its tests start live there.
const scopeRules = [
  {
    selector: ":matches(ImportSpecifier[imported.name=/^mkdtemp(Sync)?$/], " +
      `MemberExpression${writtenKeyMatching("/^mkdtemp(Sync)?$/")}, ` +
      "ObjectPattern > Property[key.name=/^mkdtemp(Sync)?$/])",
    message: temporaryFolder,
  },
  {
    selector: `CallExpression > MemberExpression.callee:matches(${writtenKey("after")}, ${writtenKey("afterEach")}), ` +
      "ImportDeclaration[source.value='node:test'] > ImportSpecifier[imported.name=/^(after|afterEach)$/]",
    message: testHook,
  },
  {
    // Types alone start nothing.
    selector: `ImportDeclaration[source.value=${childProcessModule}]:not([importKind='type'])` +
      ":has(> :matches(ImportDefaultSpecifier, ImportNamespaceSpecifier, ImportSpecifier:not([importKind='type']))), " +
      `ExportNamedDeclaration[source.value=${childProcessModule}]:not([exportKind='type']):has(> ExportSpecifier:not([exportKind='type'])), ` +
      `ExportAllDeclaration[source.value=${childProcessModule}]:not([exportKind='type']), ` +
      moduleLoad(childProcessModule),
    message: childProcess,
  },
];
// A wait for one event-loop turn: an immediate, a timer or interval with no
// delay, or setImmediate imported from the timer modules (loading them at run
// time is a real-time finding already). Test support modules are exempt:
// drained() takes its turn there, and so does the fake timers' tick.
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
// Real time reached in server code: a global timer, a timeout signal (also
// through the global object), or the timer modules imported, re-exported,
// required or loaded as a built-in by a written name. The global setTimeout is
// its own rule: the one real implementation of Timers is the boundary for it.
const globalTimeout = { selector: globalCall("/^setTimeout$/"), message: serverRealTime };
const serverRealTimeRules = [globalTimeout, {
  selector: `${globalCall("/^(setInterval|setImmediate)$/")}, ` +
    `${abortTimeout}, ` +
    `:matches(ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration)[source.value=${timersModule}], ` +
    timersLoad,
  message: serverRealTime,
}];

// The selectors of each group of files, listed once so a boundary below takes
// the same list less the one rule it is the boundary for.
const testSupportSyntax = [...unitTestRules, ...sharedMockTimersRules];
const serverSyntax = [...namedTimingRules, ...serverRealTimeRules];
const without = (rules, boundary) => rules.filter(rule => rule !== boundary);

// A later entry's no-restricted-syntax replaces an earlier one's for the same
// file, so each entry lists every selector that applies to its files, and a
// boundary entry comes after its group's.
export const projectRules = [
  {
    // A comment never turns a rule off. With inline configuration off, a
    // directive (eslint-disable, /* eslint ... */, /* global ... */) has no
    // effect and is reported as a warning, which fails lint; a file that is the
    // boundary for a rule is an entry here that names the standard it
    // implements. A TypeScript directive hides a type error instead of fixing
    // it, so none is allowed, with or without a description.
    linterOptions: { noInlineConfig: true },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/ban-ts-comment": ["error", {
        "ts-check": true, "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true,
      }],
    },
  },
  {
    files: unitTests,
    ignores: testSupport,
    rules: { "no-restricted-syntax": ["error", ...unitTestRules, ...mockTimersRules, ...ownTimerFakeRules, ...turnWaitRules, ...scopeRules] },
  },
  {
    files: testSupport,
    rules: { "no-restricted-syntax": ["error", ...testSupportSyntax] },
  },
  {
    // The cleanup scope's process time limit ends a real process's whole tree,
    // so it keeps real time (CODING_STANDARDS.md "Tests").
    files: ["tests/support/scope.ts"],
    rules: { "no-restricted-syntax": ["error", ...without(testSupportSyntax, delayedTimeout)] },
  },
  {
    files: product,
    ignores: [...tests, ...server],
    rules: { "no-restricted-syntax": ["error", ...namedTimingRules] },
  },
  {
    files: server,
    ignores: tests,
    rules: { "no-restricted-syntax": ["error", ...serverSyntax] },
  },
  {
    // systemTimers, the one real implementation of the injected Timers
    // (CODING_STANDARDS.md "Decisions apart from effects").
    files: ["server/deadline.ts"],
    rules: { "no-restricted-syntax": ["error", ...without(serverSyntax, globalTimeout)] },
  },
];

export default defineConfig([
  globalIgnores([
    "**/node_modules/",
    "test-results/",
    // Generated from server/observer-source.mjs, which is linted instead.
    "server/observer-assets.generated.ts",
  ]),
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
