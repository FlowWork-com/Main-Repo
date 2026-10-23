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
