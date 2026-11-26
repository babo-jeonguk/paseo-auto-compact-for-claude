# Agent guide

A Paseo plugin that compacts large Claude conversations while their prompt cache is still warm. Users start from [README](README.md) and [OVERVIEW](OVERVIEW.md); [runtime](docs/runtime.md) is the precise contract the code is checked against, and [CODING_STANDARDS](CODING_STANDARDS.md) holds the review rules. Setup, code layout and packaging are in [development](docs/development.md), and the simulation and E2E suites in [testing](docs/testing.md).

## Verification

- During implementation, run `npm run test:focused -- <test files>` for the changed behavior and affected callers. If the scope is unclear, run `npm test`.
- After changing `server/observer-source.mjs`, run `npm run build:observer`, add the new build to `READABLE_BUILDS` in `server/observer.test.ts` (keeping the build it replaces readable), and commit the regenerated file.
- Before handing off code or build/test configuration changes, require `npm run check`, which ends with lint, to pass after the last relevant change. Reuse a passing result until another relevant change occurs.
- Changes to how the plugin talks to Paseo or Claude are proven by the native simulation jobs in CI; read their logs, not only the job status.
- Report verification commands and results, including any failures or blockers; describe incomplete verification explicitly.
