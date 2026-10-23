# Lovable frontend integration plan

## Source of truth

`FlowWork-com/Main-Repo` remains the canonical repository for workflow lifecycle rules, task/workspace persistence, plan validation, tool execution, approvals, and verification.

The Lovable project is available in `FlowWork-com/flowowork`. It is a TanStack Start application with server functions and its own Drizzle/Supabase schema; it is not a drop-in set of React components for this repository's React + Vite app. Its Supabase project configuration is separate from Main-Repo's local project. Do not copy its `.env`, `supabase/config.toml`, or migrations into Main-Repo without an explicit schema and environment migration plan.

## Phase 1 — request-first home experience

**Merged:** PR #21.

- The home page asks, "What do you need done?"
- The request composer saves a task in the existing Planning state.
- The first non-empty line becomes the short task title; the full request is saved as task details and used as the default planning goal.
- Existing plan review, tool execution, workflow timeline, approval, and verification components stay in place.
- The interface explicitly says that creating a workflow does not execute actions automatically.

## Phase 2 — saved workflow history

**Merged:** PR #22.

- Adds Workspace and History navigation for authenticated users.
- Searches saved requests by title, details, or current status and filters by the canonical workflow statuses.
- Displays created/updated timestamps and event counts.
- Reopens the existing workflow without creating another task or executing actions.

## Phase 3 — private task attachments

**Merged:** [PR #23 — Private task attachments](https://github.com/FlowWork-com/Main-Repo/pull/23).

- Adds a private Supabase Storage bucket named `workflow-files`.
- Restricts upload to authenticated workspace members and Planning tasks.
- Restricts reads to workspace members whose workspace/task path matches the saved task.
- Restricts object deletion to the uploader; attachment metadata deletion remains guarded by the existing uploader RLS policy.
- Registers metadata through the `register_task_file` security-definer RPC only after Storage upload succeeds. It validates workspace membership, task status, uploader ownership, object path, content type, and size.
- Supports PDF, TXT, CSV, TSV, XLS, and XLSX files up to 10 MiB per file. Files are private and downloaded through the authenticated Supabase Storage client.

Attachments establish the foundation for analysis, but no file is parsed merely by being uploaded.

## Phase 4 — invoice CSV/TSV and Excel workbook review

**Merged:** PR #24 added the deterministic, read-only CSV/TSV invoice review. The current branch extends the same tool to XLS/XLSX workbooks.

- Reads only a registered file ID from the current task; server-side storage access re-checks workspace membership and resolves the object path from persisted metadata.
- Supports CSV, TSV, XLS, and XLSX up to the existing 10 MiB attachment limit; workbook reads are further bounded by worksheet, row, column, and cell limits.
- Summarizes totals by currency without conversion; missing, invalid, or ambiguous amounts are not counted as zero.
- Flags duplicates and incomplete rows, retaining duplicate values in totals but making this explicit for human review.
- Adds attachment IDs to planner context as untrusted data. Signed-plan persistence independently validates that the selected file belongs to the same task and has a supported extension/content-type pair.
- Excel review includes only the first non-empty worksheet and reports that limitation. Formula cells are blanked before analysis: the parser does not calculate formulas or trust cached formula results.
- Does not edit the source, generate spreadsheet output, send messages, or perform external writes.

The workbook parser is loaded only in the server-side Edge Function and is pinned to SheetJS 0.20.3 from its official CDN rather than the stale npm registry package. The workbook reader has focused Deno tests for formula exclusion, worksheet selection, malformed files, and workbook limits.

PDF/image invoice extraction remains separate: it requires a server-side extraction provider, strict response schema, confidence/correction tracking, and human review for uncertain fields.

## Remaining phases

1. Add PDF/image invoice extraction and field-level validation, confidence calibration, and correction tracking.
2. Add private saved prompt templates using workspace-scoped persistence and existing auth controls.
3. Port Google integrations behind server-side credential handling and explicit workspace/user authorization. Start with read-only access; keep email sending approval-gated.
4. Add richer recovery and execution orchestration only after each integration has a clear data model, tests, authorization rules, and observability.

## Security and migration rules

- Never copy the Lovable project's database migrations as-is; its task, file, OAuth, and checkpoint schemas differ from Main-Repo.
- Never put service-role keys, provider API keys, OAuth client secrets, or signing keys in Vite `VITE_*` variables or browser code.
- Keep the existing RLS, plan signing, workflow transition checks, and server-side tool-execution protections intact.
- Every phase lands on a dedicated feature branch and PR. Require typecheck, lint, tests, build, and relevant database/function validation before merge.
