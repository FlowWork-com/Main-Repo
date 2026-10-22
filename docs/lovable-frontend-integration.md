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

## Phase 4 — invoice CSV/TSV review

**In progress:** the current feature branch implements a read-only, deterministic CSV/TSV invoice review tool.

- Reads only a file ID from the current task; the server re-checks workspace membership and resolves the object path from persisted metadata.
- Uses CSV/TSV parsing without evaluating formulas or running content as code.
- Summarizes numeric totals by ISO currency without conversion; missing, invalid, and ambiguous amounts are not counted as zero.
- Flags duplicates and incomplete rows, retaining duplicate values in totals but making that explicit for human review.
- Adds the available attachment IDs to planner context as untrusted data. Signed-plan persistence independently requires the selected file to belong to the same task and have a supported CSV/TSV file type.
- Does not edit the source, create output files, send messages, or execute external writes.

This first slice does **not** parse XLS/XLSX workbooks or PDF/image invoices yet. Those require separate format-specific readers, limits, and tests before being exposed through the tool registry.

## Remaining phases

1. Add XLS/XLSX spreadsheet reading and deterministic spreadsheet summaries using a maintained parser and the same private file-resolution boundary. Preserve formulas as data; never evaluate them.
2. Add PDF/image invoice extraction behind a server-side provider, strict response schema, confidence and correction tracking, and human review for uncertain fields.
3. Add private saved prompt templates using workspace-scoped persistence and existing auth controls.
4. Port Google integrations behind server-side credential handling and explicit workspace/user authorization. Start with read-only access; keep email sending approval-gated.
5. Add richer recovery and execution orchestration only after each integration has a clear data model, tests, authorization rules, and observability.

## Security and migration rules

- Never copy the Lovable project's database migrations as-is; its task, file, OAuth, and checkpoint schemas differ from Main-Repo.
- Never put service-role keys, provider API keys, OAuth client secrets, or signing keys in Vite `VITE_*` variables or browser code.
- Keep the existing RLS, plan signing, workflow transition checks, and server-side tool-execution protections intact.
- Every phase lands on a dedicated feature branch and PR. Require typecheck, lint, tests, build, and relevant database/function validation before merge.
