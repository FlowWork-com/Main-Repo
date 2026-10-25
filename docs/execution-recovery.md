# Execution recovery and stale-run behavior

## Why it exists

The execute-tool Edge Function persists an execution claim before running a tool. If a worker/container is interrupted after that claim but before the final result is saved, the history row can remain `running` indefinitely even though the original process is gone.

## Recovery behavior

Migration `20261023150000_stale_tool_execution_recovery.sql` adds the service-role-only `recover_stale_tool_executions` function.

- The function selects only rows still in `running` and older than the configured cutoff (120 seconds to 24 hours).
- It marks a bounded batch as `failed` with the existing `EXECUTION_TIMEOUT` error code, a generic recovery message, and a completion timestamp.
- A partial index targets `started_at` for running rows; `FOR UPDATE SKIP LOCKED` lets concurrent recovery passes process different rows safely.
- It does not replay a tool, invent output/evidence, alter the task workflow status, or replace an already-final result.
- The Edge Function invokes recovery opportunistically after the request has passed authentication and workspace membership checks. If recovery is unavailable, the current request can still proceed; only a safe failure code is logged.

The default policy is a 10-minute stale cutoff and up to 50 rows per request. Current registered tools have a shorter server-side execution timeout; the wider recovery window protects against slow starts and temporary infrastructure interruptions.

## Retry guidance

An execution recovered this way is a failed historical attempt, not proof that the action never started externally. The UI should show the saved timeout state; users should inspect the workflow history and confirm no side effect occurred before submitting a new request with a new request identity. Reusing the old identity continues to replay its stored terminal outcome rather than rerunning a tool.

## Security and validation

- Only `service_role` can execute the recovery function; browser users cannot call it.
- The RPC validates cutoff and batch bounds and uses fixed, sanitized result data.
- The migration adds pgTAP coverage for cutoff selection, batch limits, untouched recent/finalized runs, error shape, repeated passes, and privilege denial for authenticated users.

## Durable plan-run recovery (Phase 6)

The plan worker never automatically retries a failed or ambiguous step. The current tool contract does not declare a safe/idempotent retry guarantee, so a paused run is a safety stop, not an invitation to click retry.

1. Inspect `workflow_plan_runs` for the run status, `pause_reason`, `policy_version`, lease timestamps, and cancellation request.
2. Inspect `workflow_plan_step_runs` in `step_index` order, including each step's attempt, execution ID, status, sanitized error, and output.
3. Correlate the step's execution ID with `task_tool_executions` and inspect `workflow_plan_run_events` for worker claims, step outcomes, lease expiry, and pause/cancel requests.
4. For `step_failed:EXECUTION_TIMEOUT`, `EXPIRED_LEASE_AMBIGUOUS_STEP`, or an execution left `running`, assume the external side effect may have happened until the provider/resource is checked. Do not create a new execution identity or replay the step before reconciling the real-world result.
5. A clean `user_paused` run may be resumed through the guarded RPC after the active lease is released. Failure, elapsed-time, and expired-lease pauses are not auto-resumable. This version deliberately has no UI operation that resets a failed step; an authorized operator must reconcile the effect and use a supported, reviewed recovery path before a new attempt.
6. A pause/cancel request during a live lease is recorded and applied after the current step returns. The current external operation may not be interruptible. Cancellation prevents later steps from being scheduled; it does not roll back the current operation.
7. Never update run/step rows directly to make them appear successful, fabricate output/evidence, or mark the task `Completed`. A successful run moves the task to `Verifying`; verification is a separate workflow stage.

If the side effect cannot be confirmed safely, leave the run paused and escalate rather than retrying. Keep secrets and raw business payloads out of logs and incident notes.
