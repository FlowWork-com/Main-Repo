begin;

select plan(10);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  (
    'a1000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'invoice-feedback-owner@example.test', '', now(), now(), now()
  ),
  (
    'a1000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'invoice-feedback-outsider@example.test', '', now(), now(), now()
  )
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  'a2000000-0000-4000-8000-000000000001',
  'Invoice feedback workspace',
  'a1000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

insert into public.tasks (id, workspace_id, owner_id, title, details, status, attempt)
values (
  'a3000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'Review invoice extraction', 'Check extracted fields and correct mistakes.', 'Verifying', 1
)
on conflict (id) do nothing;

insert into public.task_files (
  id, workspace_id, task_id, file_name, storage_path, content_type, uploaded_by
) values (
  'a4000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001',
  'invoice.pdf',
  'a2000000-0000-4000-8000-000000000001/a3000000-0000-4000-8000-000000000001/a5000000-0000-4000-8000-000000000001/invoice.pdf',
  'application/pdf',
  'a1000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.task_tool_executions (
  workspace_id, task_id, tool_id, tool_version, execution_id, request_id,
  requested_by, status, input, output, error, evidence, started_at, completed_at
) values (
  'a2000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001',
  'invoice-document-extract',
  '1.0.0',
  'a6000000-0000-4000-8000-000000000001',
  'invoice-feedback-request-1',
  'a1000000-0000-4000-8000-000000000001',
  'succeeded',
  '{"fileId":"a4000000-0000-4000-8000-000000000001"}'::jsonb,
  jsonb_build_object(
    'fileId', 'a4000000-0000-4000-8000-000000000001',
    'fileName', 'invoice.pdf',
    'sourceFormat', 'pdf',
    'reviewRequired', true,
    'validationStatus', 'needs_review',
    'fields', jsonb_build_object(
      'invoiceNumber', jsonb_build_object('value', 'INV-1', 'confidenceEstimate', 0.72, 'needsReview', true),
      'invoiceDate', jsonb_build_object('value', '2026-10-22', 'confidenceEstimate', 0.96, 'needsReview', false),
      'vendor', jsonb_build_object('value', 'Acme Ltd', 'confidenceEstimate', 0.94, 'needsReview', false),
      'description', jsonb_build_object('value', 'Services', 'confidenceEstimate', 0.91, 'needsReview', false),
      'currency', jsonb_build_object('value', 'INR', 'confidenceEstimate', 0.99, 'needsReview', false),
      'subtotal', jsonb_build_object('value', 1000, 'confidenceEstimate', 0.95, 'needsReview', false),
      'taxAmount', jsonb_build_object('value', 180, 'confidenceEstimate', 0.92, 'needsReview', false),
      'totalAmount', jsonb_build_object('value', 1180, 'confidenceEstimate', 0.98, 'needsReview', false)
    ),
    'warnings', '[]'::jsonb,
    'interpretationNotes', '[]'::jsonb
  ),
  null,
  '{"type":"invoice-document-extraction","reference":"a4000000-0000-4000-8000-000000000001"}'::jsonb,
  now(),
  now()
)
on conflict (workspace_id, task_id, execution_id) do nothing;

create temporary table invoice_feedback_payload (value jsonb);
insert into invoice_feedback_payload values (jsonb_build_object(
  'invoiceNumber', 'INV-1-CORRECTED',
  'invoiceDate', '2026-10-22',
  'vendor', 'Acme Ltd',
  'description', 'Services',
  'currency', 'INR',
  'subtotal', 1000,
  'taxAmount', 180,
  'totalAmount', 1180
));

select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select throws_ok(
  $bad_amount$ select public.record_invoice_extraction_feedback(
       'a3000000-0000-4000-8000-000000000001',
       'a6000000-0000-4000-8000-000000000001',
       'a4000000-0000-4000-8000-000000000001',
       'a7000000-0000-4000-8000-000000000003',
       jsonb_set((select value from invoice_feedback_payload), '{subtotal}', '"1000"'::jsonb)
     ) $bad_amount$,
  '22023',
  'A reviewed invoice amount field has the wrong type.',
  'the database rejects a string supplied for a numeric amount field'
);

select lives_ok(
  $$ select public.record_invoice_extraction_feedback(
       'a3000000-0000-4000-8000-000000000001',
       'a6000000-0000-4000-8000-000000000001',
       'a4000000-0000-4000-8000-000000000001',
       'a7000000-0000-4000-8000-000000000001',
       (select value from invoice_feedback_payload)
     ) $$,
  'workspace member can save human review for the matching extraction run'
);

select is(
  (select count(*) from public.invoice_extraction_feedback
   where task_id = 'a3000000-0000-4000-8000-000000000001'),
  8::bigint,
  'the review saves one row for every supported invoice field'
);

select is(
  (select count(*) from public.invoice_extraction_feedback
   where task_id = 'a3000000-0000-4000-8000-000000000001' and is_correction),
  1::bigint,
  'the original and reviewed value comparison identifies the corrected field'
);

select lives_ok(
  $$ select public.record_invoice_extraction_feedback(
       'a3000000-0000-4000-8000-000000000001',
       'a6000000-0000-4000-8000-000000000001',
       'a4000000-0000-4000-8000-000000000001',
       'a7000000-0000-4000-8000-000000000001',
       (select value from invoice_feedback_payload)
     ) $$,
  'the same submission ID and values are safely idempotent'
);

select throws_ok(
  $$ select public.record_invoice_extraction_feedback(
       'a3000000-0000-4000-8000-000000000001',
       'a6000000-0000-4000-8000-000000000001',
       'a4000000-0000-4000-8000-000000000001',
       'a7000000-0000-4000-8000-000000000001',
       jsonb_set((select value from invoice_feedback_payload), '{invoiceNumber}', '"INV-DIFFERENT"'::jsonb)
     ) $$,
  '23505',
  'Invoice feedback submission ID was reused with different values.',
  'the database rejects reusing a submission ID for different field values'
);

select throws_ok(
  $duplicate_submission$ select public.record_invoice_extraction_feedback(
       'a3000000-0000-4000-8000-000000000001',
       'a6000000-0000-4000-8000-000000000001',
       'a4000000-0000-4000-8000-000000000001',
       'a7000000-0000-4000-8000-000000000002',
       (select value from invoice_feedback_payload)
     ) $duplicate_submission$,
  '23505',
  'This invoice extraction has already been reviewed.',
  'the same extraction cannot create a second review batch with a new submission ID'
);





select is(
  (select observed_correction_rate from public.invoice_extraction_feedback_summary
   where workspace_id = 'a2000000-0000-4000-8000-000000000001'
     and field_name = 'invoiceNumber' and tool_version = '1.0.0'),
  1.0000::numeric,
  'the field summary reports the observed correction rate without labelling it accuracy'
);

reset role;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select is(
  (select count(*) from public.invoice_extraction_feedback),
  0::bigint,
  'non-members cannot read workspace extraction feedback'
);

select throws_ok(
  $$ select public.record_invoice_extraction_feedback(
       'a3000000-0000-4000-8000-000000000001',
       'a6000000-0000-4000-8000-000000000001',
       'a4000000-0000-4000-8000-000000000001',
       'a7000000-0000-4000-8000-000000000002',
       (select value from invoice_feedback_payload)
     ) $$,
  '42501',
  'Task access is required.',
  'non-members cannot submit feedback even when they know a task and run ID'
);

select * from finish();
rollback;
