# Staging invoice extraction acceptance

**Purpose:** exercise the real `invoice-document-extract` provider path using a synthetic PDF, with the production approval boundary intact. This is a manual staging test only. It is not a deployment workflow and is not a production-readiness certification.

## Preconditions

1. Deploy the current `main` revision of `execute-tool` to the dedicated FlowWork Staging project.
2. In **Supabase → Edge Functions → Secrets** for FlowWork Staging, verify that the invoice role is configured independently of the Groq planner/FinNLP reviewer:
   - `FLOWWORK_INVOICE_PROVIDER=openai-compatible`
   - `FLOWWORK_INVOICE_BASE_URL` is an HTTPS OpenAI-compatible endpoint
   - `FLOWWORK_INVOICE_MODEL` is a vision model supported by that endpoint
   - `FLOWWORK_INVOICE_API_KEY` is stored server-side
3. The current adapter sends PDFs as a Chat Completions `type: "file"` part with a base64 data URI, and images as a Chat Completions `type: "image_url"` part. The provider must support the matching payload and JSON-object response format. Do not point the invoice adapter at the Groq planner/reviewer configuration or assume that an arbitrary OpenAI-compatible provider accepts PDF file parts.
4. Configure the GitHub Actions `staging` environment:
   - Variable `STAGING_SUPABASE_PROJECT_REF`
   - Secrets `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY`
   - Secrets `STAGING_TEST_USER_EMAIL`, `STAGING_TEST_USER_PASSWORD`
   - Secrets `STAGING_APPROVER_EMAIL`, `STAGING_APPROVER_PASSWORD`
5. Choose a dedicated staging workspace containing both test users. The requester and approver must be different Supabase Auth users and both must be workspace members. The approver must not be the requester. Do not weaken or bypass the database self-approval constraint to make the smoke pass.

The staging workspace previously inspected had only one member. Add a second dedicated test user through the supported workspace membership flow before dispatching this workflow. The smoke fails before task/file creation or provider invocation if either test user cannot authenticate, is not a workspace member, or both user IDs are the same.

## Run the test

After this branch is merged to `main`, open **GitHub → Actions → Staging synthetic invoice extraction acceptance → Run workflow**. Supply:
- `workspace_id`: the dedicated staging workspace UUID
- `requester_user_id`: the synthetic task creator/uploader
- `approver_user_id`: the distinct workspace-member approver

The workflow is manual-only, requires the `staging` environment, validates the project ref/URL, and explicitly refuses the FlowWork Main DB production ref and the separate Invoice DB ref.

## What it does

1. Signs in as both configured users and verifies their identities and workspace memberships.
2. Creates a clearly named synthetic task and a one-page PDF containing fictitious invoice data.
3. Uploads the PDF to the private `workflow-files` bucket and registers it through `register_task_file`.
4. Persists a workflow approval request as the requester.
5. Persists the approval decision as the distinct approver and verifies the saved `task_approvals` record.
6. Calls the real `execute-tool` Edge Function for `invoice-document-extract` only after the approved decision is persisted.
7. Checks the provider result against the fixture, checks field-level confidence/review flags, and requires `reviewRequired: true` plus task status `Verifying`.

A passing run requires the five critical fields (invoice number, date, vendor, currency, and total) to match and at least 7 of 8 expected fields to match. It also requires the normalized result to preserve the `needs_review` status and review warnings/limitations. This is a fixture acceptance threshold, not a general accuracy claim.

## What it does not do

- It does not bypass or forge approval.
- It does not use real customer, supplier, or invoice information.
- It does not change the source document or write extracted values into invoice records.
- It does not send email, create a Gmail draft, execute a downstream tool, or contact any external business.
- It does not run automatically on each push or merge.
- It tests a live PDF provider request; JPEG/PNG live acceptance remains separate. The existing mocked adapter tests cover the image request construction.

The synthetic task and private PDF are retained in staging for audit. The script prints only task/execution/file IDs and aggregate match counts, not extracted field values or provider response bodies.

## Record the provider observation

After a successful run, use the printed task ID to inspect `provider_call_metrics` from the privileged Supabase SQL editor or another authorized operator context. Authenticated workspace users do not have direct read access to this table.

~~~sql
select
  stage,
  provider_id,
  model_id,
  outcome,
  duration_ms,
  input_tokens,
  output_tokens,
  total_tokens,
  provider_reported_cost,
  provider_reported_cost_currency,
  occurred_at
from public.provider_call_metrics
where task_id = '<synthetic task UUID>'
  and stage = 'invoice_extraction'
order by occurred_at desc;
~~~

Record the exact staging project ref, tested `execute-tool` revision, workflow run URL, task ID, provider/model ID, outcome, duration, and any usage/cost values the provider actually returned. Do not infer missing usage/cost. Do not copy credentials, raw invoice content, or raw provider responses into the audit.

A live PDF pass does not certify JPEG/PNG compatibility, invoice accuracy across a representative corpus, provider availability under load, or production readiness. Keep Phase 9 open until all other acceptance and owner-sign-off items are addressed.
