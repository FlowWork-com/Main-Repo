# Staging invoice extraction acceptance

**Purpose:** prepare a synthetic PDF invoice in FlowWork Staging and verify the real invoice-extraction provider only after a distinct workspace member explicitly approves the task in the FlowWork UI. Automated preparation is manual-only. It does not approve or execute the high-risk tool.

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
5. Choose a dedicated staging workspace containing the requester and at least one other distinct workspace member. The requester and approver must be different Supabase Auth users. The second member performs the approval in FlowWork itself; do not put an approver password in GitHub Actions or simulate approval in the script.

The staging workspace previously inspected had only one member. Add a second dedicated test user through the supported workspace membership flow before testing the approval gate. The preparation workflow fails before task/file creation or provider invocation if the requester cannot authenticate or is not a member. The task remains safely pending until the second member approves it through the UI.

## Prepare the synthetic task

After this branch is merged to `main`, open **GitHub → Actions → Prepare staging synthetic invoice for human-approved extraction → Run workflow**. Supply:
- `workspace_id`: the dedicated staging workspace UUID
- `requester_user_id`: the synthetic task creator/uploader

The workflow is manual-only, requires the `staging` environment, pins the project ref to FlowWork Staging (`flfwtsxuvzyuotltfrbt`), validates the URL, and explicitly refuses the FlowWork Main DB production ref and the separate Invoice DB ref.

The workflow signs in as the requester, creates a task with a one-page fictitious invoice PDF, uploads it to the private `workflow-files` bucket, registers the attachment through `register_task_file`, and persists a pending approval request. It verifies that the task status is `Waiting for approval` and that the `task_approvals` row is still undecided. It then exits without approving or calling the invoice provider.

The output provides:
- Task ID
- Attachment file ID
- Approval request ID

## Complete the real approval and provider test

1. Sign into the FlowWork staging app as a **different workspace member** from the requester.
2. Open the synthetic task and use the existing **Approve and continue** control. This records the approval under the second user's real authenticated identity and moves the task to `Running`. The database's no-self-approval rule remains active.
3. Sign into FlowWork as the task requester/owner. Open the same task's **Registered tools** panel and select **PDF/image invoice extraction**.
4. Set the JSON input to the attachment file ID printed by the preparation workflow:

~~~json
{"fileId":"<attachment-file-id-from-workflow-output>"}
~~~

5. Run the tool. The real `execute-tool` function will check the persisted approval before it sends the synthetic PDF to the configured provider.
6. Confirm the result is a structured report, `reviewRequired: true` remains set, field-level low-confidence/missing values remain flagged, and the workflow moves to `Verifying` for independent human review. Do not mark the task complete merely because extraction succeeded.

The expected synthetic values are invoice number SYNTH-INV-0001, date 2026-11-01, vendor Synthetic Supply Co, description Office stationery, currency INR, subtotal 1000, tax 180, and total 1180. Compare the returned values against the PDF. A passing fixture result requires the five critical fields (invoice number, date, vendor, currency, and total) to match and at least 7 of 8 expected fields to match. This is a fixture acceptance threshold, not a general accuracy claim.

## Safety boundaries

- The preparation workflow does not approve, impersonate a second user, or invoke the invoice provider.
- The provider call happens only after a distinct workspace member approves in the FlowWork UI and the task owner separately initiates tool execution.
- The test uses fictitious invoice information only.
- It does not alter the source PDF or write extracted values into invoice records.
- It does not send email, create a Gmail draft, or execute a downstream tool.
- JPEG/PNG live acceptance remains separate. The existing mocked adapter tests cover image request construction.

The synthetic task and private PDF are retained in staging for audit. The preparation script prints only task/attachment/approval IDs, not extracted field values or provider response bodies.

## Record the provider observation

After the manual provider run, use the task ID to inspect `provider_call_metrics` from the privileged Supabase SQL editor or another authorized operator context. Authenticated workspace users do not have direct read access to this table.

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

Record the exact staging project ref, tested `execute-tool` revision, preparation workflow run URL, task ID, provider/model ID, outcome, duration, and any usage/cost values the provider actually returned. Do not infer missing usage/cost. Do not copy credentials, raw invoice content, or raw provider responses into the audit.

A live PDF pass does not certify JPEG/PNG compatibility, invoice accuracy across a representative corpus, provider availability under load, or production readiness. Keep Phase 9 open until all other acceptance and owner-sign-off items are addressed.
