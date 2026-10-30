# Durable compaction operations

This note reviews established long-running-operation patterns and applies them to the **Compact now** flow. The sections up to *Implementation checkpoint* are the design recommendation as written before implementation; the checkpoint records what was built and where it differs. [The runtime contract](runtime.md#operation-storage-and-recovery) is the current behaviour.

## Conclusion

The common industry pattern is a **durable operation resource plus a reconciler/worker**:

1. Validate the request.
2. Durably create an operation before acknowledging it.
3. Return the operation identity immediately.
4. Let a worker advance the durable operation through explicit states.
5. Let clients query that operation after timeouts, reconnects and restarts.

This is the same broad model used by HTTP asynchronous request-reply APIs, Google long-running operations, Kubernetes controllers and durable workflow systems. It addresses the current problems as one system rather than as separate UI, timeout and restart exceptions.

The initial UI wording should be **Compaction requested**. It says only what the acknowledgement proves. HTTP `202 Accepted` is explicitly noncommittal: processing was accepted but is not complete and might not ultimately be performed. The response should point to a status monitor rather than imply completion ([RFC 9110, section 15.3.3](https://www.rfc-editor.org/rfc/rfc9110.html#status.202)).

The plugin does not need Kubernetes, a message broker or Temporal to use this model. While there is one plugin process and one atomic local state store, the persisted operation records themselves can be the durable queue and the existing periodic scheduler can become the reconciler.

## What established designs have in common

### Immediate acknowledgement and a durable status resource

Google recommends returning a standard `Operation` token for significant work instead of keeping the initiating RPC open. The token is polled, incomplete operations have `done=false`, and a completed operation has exactly one of a response or an error. Metadata carries progress and timestamps ([Google AIP-151](https://google.aip.dev/151), [Google `operations.proto`](https://github.com/googleapis/googleapis/blob/master/google/longrunning/operations.proto)).

Azure's asynchronous request-reply pattern similarly validates synchronously, acknowledges quickly, and gives the caller a dedicated status resource. Its suggested status representation includes a stable status, `createdAt`, `lastUpdatedAt` and a structured error. It also recommends an explicit retention policy and treats polling or push notification as delivery mechanisms over the same durable truth ([Azure asynchronous request-reply](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply)).

Most importantly, Microsoft's implementation guidance says to durably record long-running work before accepting it, not to depend on an untracked in-process task that a restart or deployment can interrupt. It recommends coordinating the operation record with enqueueing, making the worker idempotent, applying bounded retries, and keeping the durable status available after a missed notification ([Azure API implementation guidance](https://learn.microsoft.com/en-us/azure/architecture/best-practices/api-implementation#provide-asynchronous-support-for-long-running-requests)). AWS makes the same durability boundary explicit: do not acknowledge asynchronous work until it has been durably persisted; return a claim-check identifier when the client needs the eventual result ([AWS asynchronous communication](https://docs.aws.amazon.com/prescriptive-guidance/latest/modernization-integrating-microservices/asynchronous.html)).

### Caller intent and idempotent submission

AWS's preferred retry contract uses a unique caller-provided request identifier. Repeating a request with the same identifier returns a semantically equivalent state/result, while reusing the identifier for different parameters is a conflict. This lets the client recover when it cannot tell whether the original response was lost or the server never received the request ([AWS Builders' Library: Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)). Google's request-identification guidance likewise says a caller-provided request ID must guarantee idempotency and recommends a random UUID ([Google AIP-155](https://google.aip.dev/155)). Azure recommends the same behavior for asynchronous submission: a repeated idempotency key returns the existing status resource instead of creating another job ([Azure asynchronous request-reply](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply#problems-and-considerations)).

For this single-client plugin, one client-generated `operationId` can serve as the submission idempotency key and the operation identity. The server must store an input fingerprint such as `(agentId, revision, kind)`: the same ID and same fingerprint returns the existing operation; the same ID with different input is rejected.

### Reconciliation rather than ownership by one promise

Kubernetes controllers repeatedly compare durable desired state with observed state, take an action that moves the system closer to the goal, and write current status back to the resource. Controllers are expected to fail and resume from the shared resource state ([Kubernetes controller pattern](https://kubernetes.io/docs/concepts/architecture/controller/)). Kubernetes Jobs add explicit deadlines, bounded retry/backoff, terminal conditions and TTL cleanup. Kubernetes also warns that even a one-completion Job can sometimes start the same program twice, which is why the effect itself must tolerate duplicates where possible ([Kubernetes Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)).

Temporal implements the heavier version of the same idea with durable event history. It separates a per-attempt timeout from an overall execution timeout, recommends heartbeat timeouts for long-running work, carries checkpoint information across retries, and delivers cancellation through heartbeats ([Temporal failure detection](https://docs.temporal.io/encyclopedia/detecting-activity-failures)). Its event history reconstructs workflow state after a worker crash ([Temporal event history](https://docs.temporal.io/encyclopedia/event-history)).

The plugin can adopt these principles without adopting Temporal: persistent states, a startup/periodic reconciler, a lease, bounded deadlines and evidence-based recovery are sufficient for this workload.

## Assessment of the original flow

The current change is a meaningful improvement:

- `Compact now` persists a `running` job before replying.
- The initiating RPC no longer waits for Claude to finish, so Paseo's shorter plugin RPC deadline cannot create the original false failure toast.
- The operation has a server-generated ID and the UI polls session status for the matching terminal outcome.
- Ambiguous compaction outcomes remain `unknown` and are not automatically retried.

The remaining problems come from the operation still being partly process-local:

- The client learns the server-generated ID only from the acknowledgement. If that response is lost, it cannot correlate a retry with the operation that may already exist.
- `void execute(...)` owns forward progress in memory. A crash after the state write but before or during execution leaves startup recovery to convert `running` directly to `unknown`.
- `ref.send("/compact")` is outside the completion polling timeout. If it never settles, the scheduler can remain active indefinitely.
- The UI keeps the ID in component state, so closing or remounting the controls loses the completion notification.
- A manual operation and an automatic reservation share the same per-agent `Job` slot. Later activity can replace the row and erase operation history or make correlation harder.
- A final state-write failure is logged, but no durable controller later retries that transition.
- The process-local `active` flag serializes work only while this process remains alive.

There is already useful downstream protection. In the locally inspected Paseo 0.12.0 distributed source (`@getpaseo/server/dist/server/server/message-receipts/index.js`), message delivery receipts are keyed by `(agentId, messageId)`, fingerprint the payload, persist `pending` before provider send, return immediately for a duplicate `completed` receipt, and report `agent_request_outcome_unknown` for a duplicate `pending` receipt because the provider may already have accepted it. The current gateway passes the observer request ID as `messageId`. This behavior supports using one stable ID end to end, but it is an implementation detail rather than a substitute for the plugin's own durable operation contract. In particular, a completed Paseo receipt proves completion of its send call, not completion of Claude compaction.

## Recommended target design

### 1. Make an operation a first-class resource

Separate scheduled reservations from execution operations. A compact operation should have enough durable information to recover without the initiating component:

```ts
interface CompactOperation {
  id: string;                 // client generated, stable across submission retries
  agentId: string;
  revision: string;
  inputFingerprint: string;
  kind: "manual" | "automatic";
  state:
    | "requested"
    | "dispatching"
    | "observing"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "expired"
    | "unknown";
  createdAt: number;
  updatedAt: number;
  sendBy: number;
  attempt: number;
  leaseOwner?: string;
  leaseUntil?: number;
  dispatchStartedAt?: number;
  lastObservedAt?: number;
  result?: { code: string; message: string };
}
```

`requested` means accepted and durably queued, not started. `dispatching` means a worker has claimed the operation but has not established that the downstream command was accepted. `observing` means the command was or might have been accepted and the plugin is waiting for the matching native boundary. The terminal state `unknown` is deliberate: it represents an external side effect whose outcome cannot be proved.

An operation should survive new conversation activity and UI closure. The conversation row can project the latest relevant operation, but it should not be the operation's only storage location.

### 2. Use one identity end to end

Generate `operationId` in the client before the RPC and include it in the request. Persist it before acknowledging, then reuse it wherever the APIs allow:

```text
client submission ID
  = operation resource ID
  = observer request ID
  = Paseo messageId
  = log correlation ID
```

On a lost acknowledgement, the client retries with the same ID. The server returns the existing operation rather than scheduling another. If the ID is reused with a different fingerprint, it returns a conflict. If a server-generated public resource name is later required, keep a separate `requestId`, but preserve the same idempotency behavior.

This also removes the current gap between the scheduler/UI operation ID and the observer/Paseo message ID. A single identity makes logs, persisted state and native receipts directly traceable.

### 3. Treat persisted operations as the queue

The submission handler should do only the durable acceptance transaction:

1. Validate the agent, revision and current eligibility.
2. Find-or-create the operation by ID and verify its fingerprint.
3. Atomically persist it as `requested`.
4. Return `{ operationId, state: "requested" }`.
5. Optionally wake the reconciler for low latency.

The detached promise may remain as a wake-up optimization, but correctness must not depend on that promise running. The existing ten-second scheduler tick and startup path should scan nonterminal operations and advance them. A crash between steps 3 and 5 then causes delay, not loss.

With the current single atomic state file, the operation record is both registry and queue; there is no persistence-plus-broker dual write. If a separate queue is introduced later, use a transactional outbox so the operation update and enqueue intent are atomic. AWS documents the dual-write failure and notes that outbox delivery can duplicate messages, so consumers still need idempotency ([AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)).

### 4. Claim with a lease and reconcile after restart

A worker should claim an eligible `requested` operation by atomically writing `leaseOwner`, `leaseUntil`, incrementing `attempt`, and moving it to `dispatching`. It refreshes the lease or `lastObservedAt` while making progress. The host-wide one-compaction-at-a-time policy can be represented by a durable lease instead of only the in-memory `active` boolean.

On startup or lease expiry, the reconciler inspects durable evidence before acting:

- If the observer proves the matching native compaction completed, finalize `succeeded`; a completed Paseo send receipt alone is insufficient.
- If the observer or host proves rejection or failure before downstream acceptance, finalize `failed` or safely retry if the failure is classified transient and the budget remains.
- If no dispatch began, reclaim and dispatch.
- If dispatch began and downstream acceptance is ambiguous, do not blindly resend. Continue checking matching evidence until the overall deadline, then finalize `unknown`.

This last rule preserves the current safety property while allowing every non-ambiguous crash window to recover automatically.

### 5. Put bounds around every wait

Use distinct deadlines rather than one timer that begins only after `ref.send` returns:

- **Acceptance deadline:** the short plugin RPC; only durable creation must fit here.
- **Claim/lease deadline:** detects a worker that stopped making progress.
- **Dispatch attempt timeout:** covers the entire `ref.send` call.
- **Observation timeout:** bounds waiting for the native completion boundary.
- **Overall operation deadline:** bounds all attempts and observation combined.

A timeout around `ref.send` cannot cancel a side effect that the downstream system may already have accepted. Therefore dispatch timeout moves the operation to evidence reconciliation, not automatically back to `requested`. Attach handling to the late promise so a later resolve/reject cannot become unhandled, but use durable observer/Paseo evidence as the outcome authority.

Retries should be bounded, use backoff and jitter, and be limited to transitions known to be safe. A transport timeout after possible acceptance is not a definitive execution failure.

### 6. Poll the operation, and make notifications optional

Add a read contract keyed by `operationId`, or include a durable `latestOperation` projection in the session response. On mount or reconnect, the UI discovers the active/latest operation from the server rather than relying on React component state. The current two-second polling is adequate for this local operation; live agent events can continue to invalidate the query for lower latency.

The UI behavior becomes:

- Submission acknowledgement: **Compaction requested**.
- Nonterminal status: **Compacting…** with durable operation details.
- Terminal success: **Conversation compacted**.
- Terminal failure or unknown: a message derived from the persisted structured result.

A toast is an ephemeral presentation, not the receipt of record. Reopening the controls must still show the latest operation outcome. If a product requirement later demands exactly-once post-reconnect notification, add a durable `seenAt` receipt; do not infer it from whether a component happened to stay mounted.

Polling remains the recovery path even if push notifications are added. Google exposes `GetOperation`, and Azure recommends keeping durable status available after disconnects or missed notifications ([Google `operations.proto`](https://github.com/googleapis/googleapis/blob/master/google/longrunning/operations.proto), [Azure API implementation guidance](https://learn.microsoft.com/en-us/azure/architecture/best-practices/api-implementation#provide-asynchronous-support-for-long-running-requests)).

### 7. Retain terminal operations deliberately

Keep terminal operations for at least the maximum client retry/reconnect window, then remove them by TTL or a bounded per-agent history. Google AIP-151 gives 30 days as a general rule of thumb; a local plugin may choose a smaller documented interval or a last-N policy. The idempotency record must not disappear while clients can still legitimately retry the submission, or a late retry can create a duplicate operation.

Cancellation should be exposed only if it has real downstream semantics. Google defines cancellation as best effort and requires the client to continue polling because the operation may complete despite the request ([Google `operations.proto`](https://github.com/googleapis/googleapis/blob/master/google/longrunning/operations.proto)). Closing the controls should continue to mean only that the UI closed.

## The irreducible boundary

No local design can guarantee exactly-once execution across the `ref.send` boundary unless the receiving side durably recognizes the same operation identity and makes the `/compact` effect idempotent.

There is always a crash window in which Claude may have accepted the command but the plugin has not recorded that fact. A transactional outbox solves the local database-plus-enqueue dual write only when the receiving delivery path supports idempotent consumption; it does not make an arbitrary external side effect exactly once. Kubernetes explicitly documents possible duplicate starts, and AWS's idempotency guidance requires the token and mutation to participate in the service-side atomic contract.

Paseo's current message receipt implementation narrows this window and intentionally reports a pending receipt as outcome-unknown, but it does not prove that the Claude command completed. The safe policy for compaction is therefore:

1. Reuse one stable operation/message ID.
2. Reconcile observer and Paseo evidence first.
3. Retry only when non-delivery is known.
4. Preserve `unknown` when acceptance or completion remains ambiguous.

That is not a failure of the architecture; it is the standard explicit treatment of an external non-idempotent boundary.

## Implementation checkpoint: durable execution and recovery

The state file stays at version 1 and adds operation history beside the `jobs` reservations, so v1.0.2 can still read it after a rollback. One function, applied to every write, derives each job's status, detail and `attemptedAt` from its operation. Both manual and automatic attempts are persisted as `requested` before execution. `auto-compact.now` accepts a caller UUID and native target (`sessionId`, `activityKey`), fingerprints the original input (agent, revision and native target, not the `(agentId, revision, kind)` suggested above, because the target is what a retry must match), resolves duplicates before live eligibility checks, and returns structured `accepted`, `existing`, `blocked` or `idempotency_conflict` codes. Those input fields remain optional for already-mounted older clients. `auto-compact.operation` reads an outcome independently of current session eligibility or a replaced reservation. Session rows expose active/latest operations, and the controls reuse an unconfirmed submission's ID only while its input is unchanged, and poll by ID.

`server/operations.ts` now owns execution and reconciliation. The scheduler and worker use one serialized state transaction queue. The state lifecycle is `requested → dispatching → observing → succeeded | failed | unknown`, with `expired` reserved for unsent work. Acceptance only wakes the worker; startup and the periodic tick also find persisted work. Automatic reservation consumption and operation creation share one state write. Jobs v1.0.2 left running, and all its attempted jobs, become `legacy` history: v1.0.2 recorded neither who asked nor whether anything was sent, so legacy attempts always count as possibly sent.

The worker records itself as the operation's `owner` when it claims it; startup recovery clears owners, and a checkpoint from any earlier owner fails. A time-based lease was dropped: with a single writer nothing read its expiry. Deadlines follow the phase (`server/deadline.ts`): the dispatch marker must be written within 180 seconds of acceptance, also bounded by an automatic reservation's delivery window, and observation then runs for 180 seconds from the marker. An earlier version used one deadline for both, so a send late in its delivery window was cut off as `unknown` seconds later. Every pre-send read of host, settings, state or observer is bounded to five seconds. Not being able to read is a fault, never a reading: the observer distinguishes an absent observer (none, closed, stale) from one it could not read, and only the first is a refusal. Before the marker the gateway never returns an outcome; it throws, and the worker alone classifies what it threw. A `Refusal` (session changed, Claude still working, cache window, a compaction of that conversation already running) ends the attempt as `failed_before_dispatch`. Any other error is a fault, retried with persisted exponential backoff (capped at 30 seconds, with jitter) until the send deadline, after which the request expires unsent; the worker wakes itself for each retry. An earlier version classified refusals inside the gateway call and also capped retries at three attempts, so a refusal thrown outside that call was retried as a fault, and an automatic attempt that met an unreadable observer three times was lost for good. The native observer admits the compaction until the latest time its observation can end (`sendBy` plus the observation time); the send deadline and delivery window bound only when sending may start. Automatic eligibility is one function, `server/policy.ts`, used both for the reservation and just before sending. A durable marker is committed immediately before `ref.send`; once that marker exists, recovery never resends, even if the crash happened before the send call itself.

The operation ID now also identifies the observer request and Paseo message. Gateway dispatch waits at most 30 seconds for the send promise. Preparation is bounded by the send deadline; live observation gets 120 seconds from the marker. A dispatch timeout is not cancellation: late resolution/rejection is consumed, and evidence observation continues. Subscription establishment, refresh, evidence reads and cleanup are bounded as well (cleanup has its own one-second allowance). Unconfirmed sent work stays `observing` for periodic reconciliation until the observation deadline. A persisted invalidation or native terminal rejection may finish earlier.

New observer sessions write per-operation terminal receipts under the agent's `receipts` directory, outside launch directories that can be pruned. Reads validate ID, launch, generation, session and activity revision, but do not require a fresh/open current ledger. Partial or temporarily unavailable ledger/receipt reads are retried rather than treated as completion. Recovery requires a matching native receipt plus either a checkpointed command-turn boundary or a boundary recovered from a timeline page containing the exact message ID. Timeline recovery reads at most 200 entries; missing evidence remains ambiguous. A send receipt alone never establishes compaction success. Already-open older observer builds remain usable for live execution, but must be reopened to gain durable native receipts.

Failed terminal state writes are retried from the in-process outcome on the next reconcile. After restart, matching persisted receipts and command-boundary evidence recover successful work; otherwise the deadline produces `unknown`. A stopped scheduler cannot write at all, and a transaction that changed nothing writes nothing, so a stopped worker cannot publish a late result over a recovered operation, nor put back state a newer instance replaced. Recovery assumes a single writer: leases do not replace an OS lock or transactional store for multiple plugin processes, and atomic rename does not promise power-loss durability.

`server/retention.ts` now applies a seven-day terminal history policy, measured from the later of creation and final update. Startup and hourly sweeps run under the scheduler's state queue, even offline or with automation disabled. Pending records are never pruned. A pass handles up to 100 expired records without evicting younger entries to meet a count limit. Receipt deletion precedes state removal: a deletion failure retains the outcome; a state-write failure retains the operation and repeats deletion after restart. Backlogs and deletion failures retry on the next tick. An orphan sweep after commit protects all retained IDs and collects old terminal or partial receipts, including late writes from older observer builds. New observers avoid rewriting an unchanged successful receipt on every heartbeat.

Whether an attempt may have sent is decided only from durable state: an `expired` operation, or a `failed` one without the dispatch marker, provably sent nothing, and Compact now may try that activity again under a new ID; result codes `failed_before_dispatch`/`failed_after_dispatch` say which. Automatic compaction never repeats an activity. A minimal last-activity guard stays in the reservation projection after its history is deleted; its operation ID and detailed outcome do not. The gateway keeps the matching native compaction revision as the activity identity after compaction consumes the ordinary scheduling window. This prevents same-activity resend even if Paseo advances its message timestamp, while allowing a new native generation with the same host revision. After retention cleanup, operation lookup returns `null` and ID deduplication/conflict checking no longer applies to that ID. A missing aged record is not evidence of non-delivery. There is no hard byte bound: cleanup failures, pending work, per-conversation policy and activity guards may outlive the history window. See [the runtime retention contract](runtime.md#history-retention).

Optional persistence of unconfirmed client submissions across application restarts remains follow-up work. There is no public cancellation contract.

Regression coverage includes lost acknowledgements, conflicting IDs, native identity changes, replaced reservations, failed acceptance/terminal writes, interrupted-worker recovery, stale ownership, fixed deadlines, pre-send retries bounded by the send deadline, refusals classified wherever they are thrown, never-settling send/subscription/refresh/cleanup, receipt validation and pruning, and client remount identity reuse. The native simulation also checks plugin reload during a held compaction, one model request, and recovery of the exact operation's native receipt and timeline boundary.

## Suggested implementation order

1. Change the initial toast to **Compaction requested**.
2. Introduce a versioned `operations` collection separate from scheduling reservations.
3. Add client-generated operation IDs, fingerprints and idempotent find-or-create submission.
4. Replace in-memory ownership with startup/periodic reconciliation and durable leases.
5. Pass the same ID through observer preparation and Paseo `messageId`.
6. Bound the entire dispatch and observation lifecycle, preserving ambiguous outcomes as `unknown`.
7. Make the UI query/recover operation state by ID and add retention cleanup.

The critical regression scenarios are: lost acknowledgement followed by retry; crash after acceptance but before dispatch; crash while dispatch is ambiguous; `ref.send` never settling; final state-write failure; UI close/reopen during execution; same ID with different input; and cleanup after the documented retention window.
