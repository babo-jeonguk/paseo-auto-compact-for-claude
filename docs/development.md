# Development

Clone the public plugin repository, then use Node 24+ from its directory:

```sh
git clone https://github.com/babo-jeonguk/paseo-auto-compact-for-claude.git
cd paseo-auto-compact-for-claude
npm ci --ignore-scripts
npm run build:observer
npm run check
```

`check` verifies the embedded observer source, TypeScript, scheduling, file persistence, conversation controls and execution tests. Run `build:observer` after changing `server/observer-source.mjs`. The fast CI matrix runs these checks on Linux, macOS and Windows. Separate native simulation jobs exercise real Claude and Paseo on Linux and Windows.

## Execution

`index.server.ts` adds the Claude observer to interactive sessions. `server/observer.ts` prepares session-local Mod files and validates observations. `server/observer-source.mjs` uses official Claude Mod events to record native activity, request times, effective TTL policy, the actual Stop-hook transcript path and compaction completion. `server/cache.ts` reads a bounded transcript tail and resolves observed, configured or assumed TTL without making missing metadata a blanket scheduling gate. `server/gateway.ts` sends `/compact` through Paseo's public interface, correlates the message's turn and requires native completion. `server/scheduler.ts` owns reservations, settings checks, skip/undo and no-replay recovery.

Provider commands, process launchers, IPC sockets and other plugins' runtime inventories are outside this package. See [execution limits and migration](runtime.md).

## Local installation

From this checkout, install the development directory on an isolated test daemon:

```sh
paseo plugin install .
```

After editing installed files, run `paseo plugin reload auto-compact-for-claude`. Existing Claude sessions need to reopen to load a changed observer; their provider command is preserved. For ordinary use, follow the [GitHub installation instructions](../README.md#install).

## Packaging and releases

```sh
npm pack --dry-run --ignore-scripts
npm pack
```

The package includes the client, server, embedded observer, documentation and screenshots. Keep public links and assets within this directory. `prepack` rebuilds the observer and runs checks. `npm pack` writes a versioned `.tgz` into the current directory.

Distribution uses the public GitHub repository and GitHub Releases. `private: true` prevents accidental npm publication; it does not restrict the public Git repository or installation through Paseo. Release versions in `package.json` and `package-lock.json` must agree, and Git tags use the `v` prefix. A specific published tag can be selected with the install command's `--ref` option.

Text files use LF line endings on every OS. Keep `.gitattributes` in the checkout: the embedded observer's source hash and generated-file check must remain identical on Windows.

For each update, run `npm run test:update`. It combines these fast checks with the repeatable native Linux/Windows simulation. See [simulation setup, coverage and reports](testing.md).

## Reference-driven validation

TTL collection follows the transcript approach in [claude-cache](https://github.com/the-cybersapien/claude-cache/blob/5b038ace690d74060f01d19b9b1f7e253914e151/hooks/register.tsx#L85-L103). Timer lifecycle and SDK differences were compared with [davidar/claude-idle-compact](https://github.com/davidar/claude-idle-compact/tree/35ec925345acfce26bc0ba260c1f611dceab1148) and [intenex/claude-idle-compactor](https://github.com/intenex/claude-idle-compactor/tree/fdd49d222a3bcea6a1fffc85d72199dad3aacd7c). The product keeps public Paseo dispatch; the references' terminal-only direct compact calls do not establish SDK safety.

The public `tests/simulation/` fixture checks actual native transcript metadata, real 50/55-minute reservation values, shortened real automatic timers, same-session completion, input overlap and recovery. Missing, five-minute, mixed, settings and environment TTL cases run through native Claude too. These use a synthetic loopback model; they do not measure Anthropic's cache or claim a real 55-minute warm-cache run.
