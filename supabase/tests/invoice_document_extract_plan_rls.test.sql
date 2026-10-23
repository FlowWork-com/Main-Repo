begin;

select plan(5);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values (
  '96000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'document-plan-owner@example.test', '', now(), now(), now()
)
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  '97000000-0000-4000-8000-000000000001',
  'Invoice document plan workspace',
  '96000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '97000000-0000-4000-8000-000000000001',
  '96000000-0000-4000-8000-000000000001',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

insert into public.tasks (id, workspace_id, owner_id, title, details, status, attempt)
values (
  '98000000-0000-4000-8000-000000000001',
  '97000000-0000-4000-8000-000000000001',
  '96000000-0000-4000-8000-000000000001',
  'Extract invoice document', 'Extract fields and flag uncertain values for review.', 'Planning', 1
)
on conflict (id) do nothing;

insert into public.task_files (
  id, workspace_id, task_id, file_name, storage_path, content_type, uploaded_by
) values
  (
    '99000000-0000-4000-8000-000000000001',
    '97000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000001',
    'invoice.pdf',
    '97000000-0000-4000-8000-000000000001/98000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000001/invoice.pdf',
    'application/pdf',
    '96000000-0000-4000-8000-000000000001'
  ),
  (
    '99000000-0000-4000-8000-000000000002',
    '97000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000001',
    'invoice.jpg',
    '97000000-0000-4000-8000-000000000001/98000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000002/invoice.jpg',
    'image/jpeg',
    '96000000-0000-4000-8000-000000000001'
  ),
  (
    '99000000-0000-4000-8000-000000000003',
    '97000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000001',
    'invoice.png',
    '97000000-0000-4000-8000-000000000001/98000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000003/invoice.png',
    'image/png',
    '96000000-0000-4000-8000-000000000001'
  ),
  (
    '99000000-0000-4000-8000-000000000004',
    '97000000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000001',
    'invoices.xlsx',
    '97000000-0000-4000-8000-000000000001/98000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000004/invoices.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '96000000-0000-4000-8000-000000000001'
  );

create temporary table document_plan_payload (value jsonb);
insert into document_plan_payload values (jsonb_build_object(
  'id', 'ignored-by-server',
  'taskId', '98000000-0000-4000-8000-000000000001',
  'goal', 'Extract invoice fields from the attached document and flag uncertain values for review.',
  'summary', 'Extract supported invoice fields and identify what a human must verify.',
  'steps', jsonb_build_array(jsonb_build_object(
    'id', 'extract_invoice',
    'title', 'Extract invoice fields',
    'description', 'Read the registered PDF or image and return field-level confidence estimates and validation warnings.',
    'toolId', 'invoice-document-extract',
    'toolVersion', '1.0.0',
    'input', jsonb_build_object('fileId', '99000000-0000-4000-8000-000000000001'),
    'dependencies', '[]'::jsonb,
    'expectedOutcome', 'Invoice fields, confidence estimates, and validation warnings are returned.',
    'verificationCriteria', 'All fields are marked for human review and uncertain values are not silently replaced.'
  )),
  'dependencies', '[]'::jsonb,
  'createdAt', now()::text,
  'version', 1,
  'validationStatus', 'invalid',
  'limitations', '[]'::jsonb
));

grant select on document_plan_payload to authenticated;

select vault.create_secret(
  'document-plan-test-signing-key-at-least-32-characters',
  'flowwork-plan-signing-key',
  'Temporary signing key for invoice document plan tests'
);

create function pg_temp.create_signed_document_plan(p_task_id uuid, p_plan jsonb)
returns jsonb
language sql
as $$
  select public.create_workflow_plan(
    p_task_id,
    p_plan::text,
    encode(
      extensions.hmac(
        p_plan::text,
        'document-plan-test-signing-key-at-least-32-characters'::text,
        'sha256'::text
      ),
      'hex'
    )
  );
$$;

select set_config('request.jwt.claim.sub', '96000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select lives_ok(
  $$ select pg_temp.create_signed_document_plan(
       '98000000-0000-4000-8000-000000000001',
       (select value from document_plan_payload)
     ) $$,
  'a signed plan may reference a PDF attachment owned by the same task'
);

select lives_ok(
  $$ select pg_temp.create_signed_document_plan(
       '98000000-0000-4000-8000-000000000001',
       jsonb_set(
         (select value from document_plan_payload),
         '{steps,0,input,fileId}',
         '"99000000-0000-4000-8000-000000000002"'::jsonb
       )
     ) $$,
  'a signed plan may reference a JPEG attachment owned by the same task'
);

select lives_ok(
  $$ select pg_temp.create_signed_document_plan(
       '98000000-0000-4000-8000-000000000001',
       jsonb_set(
         (select value from document_plan_payload),
         '{steps,0,input,fileId}',
         '"99000000-0000-4000-8000-000000000003"'::jsonb
       )
     ) $$,
  'a signed plan may reference a PNG attachment owned by the same task'
);

select throws_ok(
  $$ select pg_temp.create_signed_document_plan(
       '98000000-0000-4000-8000-000000000001',
       jsonb_set(
         (select value from document_plan_payload),
         '{steps,0,input,fileId}',
         '"99000000-0000-4000-8000-000000000004"'::jsonb
       )
     ) $$,
  '22023',
  'Plan contains invalid invoice-document-extract input.',
  'the extraction plan rejects spreadsheet files'
);

select throws_ok(
  $$ select pg_temp.create_signed_document_plan(
       '98000000-0000-4000-8000-000000000001',
       jsonb_set(
         (select value from document_plan_payload),
         '{steps,0,input,fileId}',
         '"99000000-0000-4000-8000-000000000099"'::jsonb
       )
     ) $$,
  '22023',
  'Plan contains invalid invoice-document-extract input.',
  'the extraction plan rejects unregistered or cross-task file IDs'
);

select * from finish();
rollback;
