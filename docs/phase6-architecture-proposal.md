# Phase 6: bounded plan-run worker

## Repository findings

- Phase 5 persists accepted plan snapshots in `workflow_plan_runs` and `workflow_plan_step_runs`, but the UI currently requires one explicit execution action per step.
- `execute-tool` is a request/response Edge Function and the existing stale-execution RPC only recovers `task_tool_executions`; neither is a durable plan-run dispatcher.
- The checked-in Supabase config does not configure a cron/scheduler extension or queue service. The implementation must not silently depend on one.
- Current tool definitions do not expose a reviewed idempotency/safe-retry contract. Ambiguous failures must pause instead of automatically replaying a potentially external side effect.

## Implemented architecture

1. Add a Postgres-backed dispatch queue with a unique outstanding job per run, bounded attempts, lease owner/expiry, and sanitized event history. Use row locks / `SKIP LOCKED` and compare-and-set updates to prevent duplicate concurrent claims.
2. A server-side Edge Function processes at most one plan step per invocation. It re-reads run/task/step state, checks membership/accepted plan and dependencies, validates the persisted tool input through the canonical registry, claims a lease, executes via the existing `ToolExecutionService`, and commits the outcome before dispatching follow-up work.
3. Dispatch work is durable and independent of a browser tab. Because no queue or cron extension is configured in this repository, implementation must either use a documented supported Supabase runtime mechanism with a server-only dispatch credential, or leave a clear operational prerequisite rather than pretending that a database row alone runs a worker.
4. Add server-checked pause, resume, and cancellation. Stop scheduling new work after pause/cancel. Do not claim a running external tool was cancelled unless its contract supports cancellation.
5. Failed, invalid, approval-required, or ambiguous steps pause for human review. Automatic retries are disabled unless a tool explicitly declares safe idempotency and uses a stable idempotency identity. No generic plan acceptance counts as operation-specific approval.
6. Enforce at most 10 steps, bounded attempts and execution time, and a versioned run policy. Keep the parent task in `Running` until all required steps succeed; then move to `Verifying`, never directly to `Completed`.
7. Add SQL/RLS tests for concurrent claims, lease expiry, dispatch replay, workspace isolation, pause/resume/cancel, failure recovery, and all workflow status transitions; add Edge Function tests for authenticated user vs internal worker dispatch and sanitized failures.

## Scope and non-goals

- No new external integration or write capability.
- No arbitrary code, shell, SQL, or model-controlled URLs.
- No automatic replay of non-idempotent or ambiguous operations.
- No assumed pg_cron, pg_net, pgmq, or other extension unless availability is verified and CI can exercise the required path.
- No direct pushes to `main`; this is a draft PR until checks and review are complete.


## Implemented behavior and remaining operational notes

- `workflow_plan_runs` doubles as the durable dispatch record and has a single database lease owner/expiry, heartbeat timestamp, policy version, maximum elapsed time, and maximum automatic step attempts.
- `advance-plan-run` verifies either a user JWT plus workspace membership or an internal server-only dispatch credential. It uses `EdgeRuntime.waitUntil` and invokes itself for the next step only after durable finalization; each invocation claims one lease and attempts at most one step.
- User controls are backed by guarded RPCs. Only a clean user pause is automatically resumable. A failed step, elapsed limit, or expired lease with an in-flight step remains paused for review.
- Current tool contracts do not expose idempotency metadata, so the stored policy allows one automatic attempt per step and no automatic retries. This intentionally favors duplicate-effect safety over unattended recovery.
- CI checks and tests the worker handler and its SQL privilege/lease behavior. Production runtime configuration and a staging end-to-end run still need to be verified in the target Supabase project; local CI does not certify production background-task availability.
