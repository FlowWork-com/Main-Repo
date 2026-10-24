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

**Merged:** [PR #26 — approval-gated PDF/image extraction](https://github.com/FlowWork-com/Main-Repo/pull/26).

- Supports private PDF, JPG/JPEG, and PNG attachments after server-side MIME, extension, file-signature, size, workspace, and task checks.
- Sends the original document to a separately configured server-side OpenAI-compatible vision endpoint only after the high-risk tool's persisted approval gate is satisfied.
- Returns invoice number, date, vendor, description, currency, subtotal, tax, and grand total with per-field model-estimated confidence.
- Adds deterministic warnings for missing/low-confidence fields, invalid dates/currency codes, and subtotal-plus-tax mismatches.
- Every result requires human review. Confidence values are model self-estimates, not calibrated probabilities. Extraction does not create or edit invoice records.

### Provider configuration

Set these as **server-side Supabase Edge Function secrets**, not browser `VITE_*` variables and never in Git:

- `FLOWWORK_INVOICE_PROVIDER=openai-compatible`
- `FLOWWORK_INVOICE_BASE_URL=https://api.openai.com/v1` (or a trusted compatible endpoint that supports the required PDF file and image content formats)
- `FLOWWORK_INVOICE_MODEL=<vision-capable-model>`
- `FLOWWORK_INVOICE_API_KEY=<server-side-api-key>`

When these secrets are absent or incomplete, extraction fails closed as unavailable. Do not configure a provider unless it is authorized to receive the invoice documents users submit.

## Phase 6 — human extraction review and feedback metrics

**Merged:** [PR #27 — human extraction corrections and review metrics](https://github.com/FlowWork-com/Main-Repo/pull/27).

- Reviewers can accept or correct all eight extracted fields from a saved PDF/image extraction, including explicitly confirming a field is missing.
- Feedback is accepted only for a successful extraction execution whose saved input/output reference the same private file and task.
- The database derives source values and confidence estimates from the saved execution output; clients cannot submit fabricated source values or confidence estimates.
- Feedback is stored per field and extraction run, scoped by workspace, with stable submission IDs for safe retries. Duplicate reviews are rejected.
- Workspace-protected summaries report reviewed counts and observed correction rates by field and tool version, plus mean reported confidence for corrected and unchanged values.
- These metrics describe reviewer outcomes, not independently verified accuracy.

## Phase 7 — private versioned workspace prompt templates

**Merged:** [PR #28 — versioned prompt templates](https://github.com/FlowWork-com/Main-Repo/pull/28).

- Workspace members can create, use, version, and archive prompt templates.
- Each edit creates an immutable version. Optimistic concurrency prevents stale edits from silently overwriting newer ones.
- Templates only fill the request composer; they do not create tasks, bypass plan review, or execute work automatically.
- Workspace RLS and membership-checked RPCs protect access and mutations.

## Phase 8 — read-only Google Workspace connection

**Merged:** [PR #29 — Google Workspace connection](https://github.com/FlowWork-com/Main-Repo/pull/29).

- OAuth uses state and PKCE; token material is stored server-side in Vault.
- Workspace members can explicitly connect an account and list allowed Drive file metadata using the limited `drive.file` scope.
- A selected-file preview supports Google Docs and Slides as plain text, Google Sheets as first-sheet CSV, and common text files. It requires `capabilities.canDownload`, is bounded to 256 KiB, and is not saved to task history or sent to the planner.
- Binary previews and all Drive writes remain out of scope. Gmail access and email sending are not included.
- No provider calls occur until an authenticated member initiates connection and grants consent.

## Phase 9 — stale tool-execution recovery

**Merged:** [PR #31 — stale execution recovery](https://github.com/FlowWork-com/Main-Repo/pull/31).

- Old execution rows left in `running` after worker interruption are finalized as failed with `EXECUTION_TIMEOUT`.
- Recovery is bounded, service-role-only, and uses row locks to avoid competing workers processing the same execution.
- It does not rerun tools or infer whether an external side effect happened. Users must inspect history before deciding whether to retry.
- Recovery is opportunistic on the next authenticated tool request, not a background scheduler.

## Phase 10 — extraction quality monitoring

**Merged:** [PR #32 — workspace extraction quality monitoring](https://github.com/FlowWork-com/Main-Repo/pull/32).

- Shows field-level reviewed counts, corrections, observed correction rates, and mean reported confidence when fields were corrected or unchanged.
- Groups correction rates into reported-confidence bands by field and tool version so teams can identify where reviewers frequently intervene.
- Low sample sizes are called out instead of hidden.
- Queries use workspace-scoped aggregate views. The UI does not retrieve or display raw extracted/reviewed invoice values in metric tables.
- These are descriptive human-review signals, not independent ground truth, a parser accuracy benchmark, or proof that confidence is calibrated.

## Phase 11 — deterministic held-out extraction evaluation

**In progress:** the `feat/invoice-extraction-benchmark` branch adds a deterministic evaluator for field-level invoice extraction results.

- Scores invoice number, date, vendor, description, currency, subtotal, tax, and grand total against separately labeled reference values.
- Reports per-field and aggregate exact-match accuracy, value coverage, abstentions, and unexpected values. Monetary values use a documented one-cent tolerance; text normalization is intentionally conservative.
- Computes confidence-band observed accuracy and expected calibration error only for manifests explicitly marked as held-out, human-verified data. Small bins remain flagged.
- Includes a small synthetic smoke fixture to verify evaluator behavior. Its scores are explicitly **not** model accuracy and must never be used as a product-performance claim.
- The evaluator prints only aggregate metrics; it never prints field values, source text, or invoice documents. It makes no provider requests.

### Running the evaluator

Run `npm run evaluate:invoices` to score the built-in synthetic smoke fixture and verify the runner. This validates the harness only.

To evaluate a real held-out benchmark, prepare a separate JSON manifest using the schema shown in `fixtures/invoice-extraction/synthetic-smoke-v1.json`, with:
- `datasetType: "human-verified-holdout"` and `split: "held_out"`;
- `truthStatus: "human_verified"` on every record;
- a unique `caseId`, all eight independently reviewed ground-truth field values, and the corresponding saved extraction field values/confidence estimates;
- a fixed `toolVersion`, non-secret `modelId`, and a description of the review protocol.

Run it with `npm run evaluate:invoices -- --input /path/to/held-out-manifest.json`. Keep real invoices and customer-derived labels in approved private storage; do not commit raw customer documents or sensitive values to this repository. The runner checks the manifest's declarations and output contract but cannot independently prove that a label was genuinely human-reviewed. Report held-out metrics only after the reference set has been independently verified.

## Security and migration rules

- Never copy the Lovable project's database migrations as-is; its task, file, OAuth, and checkpoint schemas differ from Main-Repo.
- Never put service-role keys, provider API keys, OAuth client secrets, or signing keys in Vite `VITE_*` variables or browser code.
- Keep the existing RLS, plan signing, workflow transition checks, and server-side tool-execution protections intact.
- Every phase lands on a dedicated feature branch and PR. Require typecheck, lint, tests, build, and relevant database/function validation before merge.
