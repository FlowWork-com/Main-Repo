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

## Phase 4 — CSV/TSV and Excel invoice review

**Merged:** [PR #24 — CSV/TSV review](https://github.com/FlowWork-com/Main-Repo/pull/24) and [PR #25 — XLS/XLSX review](https://github.com/FlowWork-com/Main-Repo/pull/25).

- Reads only a file ID from the current task; the server re-checks workspace membership and resolves the object path from persisted metadata.
- Supports CSV, TSV, XLS, and XLSX; summarizes numeric totals by currency without conversion.
- Missing, invalid, and ambiguous amounts are not counted as zero. Duplicate invoices and incomplete rows are flagged for review.
- Workbook formulas are excluded and never calculated. Only the first non-empty worksheet is included.
- The source document is not edited; no email, external write, or automatic workflow execution is triggered by the review.

## Phase 5 — PDF/image invoice extraction

**In progress:** the `feat/invoice-document-extraction` branch implements approval-gated extraction for PDF, JPG/JPEG, and PNG attachments.

- Supports private PDF, JPG/JPEG, and PNG attachments after server-side MIME, extension, file-signature, size, workspace, and task checks.
- Sends the original document to a separately configured server-side OpenAI-compatible vision endpoint only when the high-risk tool's approval gate has been satisfied.
- Returns invoice number, date, vendor, description, currency, subtotal, tax, and grand total with per-field model-estimated confidence.
- Adds deterministic validation warnings for missing/low-confidence fields, invalid dates/currency codes, and subtotal-plus-tax mismatches.
- Every result requires human review. Confidence values are model self-estimates, not calibrated probabilities. This phase does not save an invoice record, modify the source, or send content anywhere except the explicitly configured provider.

### Provider configuration

Set the following as **server-side Supabase Edge Function secrets**, not browser `VITE_*` variables and never in Git:

- `FLOWWORK_INVOICE_PROVIDER=openai-compatible`
- `FLOWWORK_INVOICE_BASE_URL=https://api.openai.com/v1` (or the trusted base URL of an OpenAI-compatible service that supports image and file content parts)
- `FLOWWORK_INVOICE_MODEL=<vision-capable-model>`
- `FLOWWORK_INVOICE_API_KEY=<server-side-api-key>`

When these secrets are absent or incomplete, invoice document extraction fails closed as unavailable. Do not configure an endpoint that is not authorized to receive the invoice data users submit.

## Remaining phases

1. Add correction persistence and evaluation fixtures before treating model confidence as an operational reliability metric.
2. Add private saved prompt templates using workspace-scoped persistence and existing auth controls.
3. Port Google integrations behind server-side credential handling and explicit workspace/user authorization. Start with read-only access; keep email sending approval-gated.
4. Add richer recovery and execution orchestration only after each integration has a clear data model, tests, authorization rules, and observability.

## Security and migration rules

- Never copy the Lovable project's database migrations as-is; its task, file, OAuth, and checkpoint schemas differ from Main-Repo.
- Never put service-role keys, provider API keys, OAuth client secrets, or signing keys in Vite `VITE_*` variables or browser code.
- Keep the existing RLS, plan signing, workflow transition checks, and server-side tool-execution protections intact.
- Every phase lands on a dedicated feature branch and PR. Require typecheck, lint, tests, build, and relevant database/function validation before merge.
