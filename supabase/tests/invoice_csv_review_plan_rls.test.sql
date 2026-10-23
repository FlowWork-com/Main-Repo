begin;

select plan(5);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values (
  '91000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'csv-plan-owner@example.test', '', now(), now(), now()
)
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  '92000000-0000-4000-8000-000000000001',
  'CSV plan workspace',
  '91000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '92000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

insert into public.tasks (id, workspace_id, owner_id, title, details, status, attempt)
values (
  '93000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  'Review invoices CSV', 'Review attached invoice export.', 'Planning', 1
)
on conflict (id) do nothing;

insert into public.task_files (
  id, workspace_id, task_id, file_name, storage_path, content_type, uploaded_by
) values
  (
    '94000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000001',
    'invoices.csv',
    '92000000-0000-4000-8000-000000000001/93000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000001/invoices.csv',
    'text/csv',
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    '94000000-0000-4000-8000-000000000002',
    '92000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000001',
    'invoice.pdf',
    '92000000-0000-4000-8000-000000000001/93000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000002/invoice.pdf',
    'application/pdf',
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    '94000000-0000-4000-8000-000000000003',
    '92000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000001',
    'invoices.xlsx',
    '92000000-0000-4000-8000-000000000001/93000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000003/invoices.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    '94000000-0000-4000-8000-000000000004',
    '92000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000001',
    'invoices.xls',
    '92000000-0000-4000-8000-000000000001/93000000-0000-4000-8000-000000000001/95000000-0000-4000-8000-000000000004/invoices.xls',
    'application/vnd.ms-excel',
    '91000000-0000-4000-8000-000000000001'
  );

create temporary table csv_plan_payload (value jsonb);
insert into csv_plan_payload values (jsonb_build_object(
  'id', 'ignored-by-server',
  'taskId', '93000000-0000-4000-8000-000000000001',
  'goal', 'Review the attached invoice CSV and summarize totals by currency.',
  'summary', 'Summarize the attached invoice table with row-level warnings.',
  'steps', jsonb_build_array(jsonb_build_object(
    'id', 'step_1',
    'title', 'Review invoice CSV',
    'description', 'Read the attached CSV and summarize safe, deterministic findings.',
    'toolId', 'invoice-csv-review',
    'toolVersion', '1.0.0',
    'input', jsonb_build_object('fileId', '94000000-0000-4000-8000-000000000001'),
    'dependencies', '[]'::jsonb,
    'expectedOutcome', 'Currency totals and flagged source rows are returned.',
    'verificationCriteria', 'Totals are separated by currency and invalid amounts are excluded.'
  )),
  'dependencies', '[]'::jsonb,
  'createdAt', now()::text,
  'version', 1,
  'validationStatus', 'invalid',
  'limitations', '[]'::jsonb
));

-- The test deliberately switches to authenticated below; grant the role read access
-- to this session-local fixture so failures exercise create_workflow_plan, not the fixture ACL.
grant select on csv_plan_payload to authenticated;

select vault.create_secret(
  'csv-plan-test-signing-key-at-least-32-characters-long',
  'flowwork-plan-signing-key',
  'Temporary signing key for invoice CSV plan database tests'
);

create function pg_temp.create_signed_workflow_plan(p_task_id uuid, p_plan jsonb)
returns jsonb
language sql
as $$
  select public.create_workflow_plan(
    p_task_id,
    p_plan::text,
    encode(
      extensions.hmac(
        p_plan::text,
        'csv-plan-test-signing-key-at-least-32-characters-long'::text,
        'sha256'::text
      ),
      'hex'
    )
  );
$$;

select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select lives_ok(
  $$ select pg_temp.create_signed_workflow_plan(
       '93000000-0000-4000-8000-000000000001',
       (select value from csv_plan_payload)
     ) $$,
  'a signed plan can reference a CSV attachment owned by the same task'
);

select is(
  (select plan->>'validationStatus' from public.workflow_plans limit 1),
  'valid',
  'the invoice review tool is validated by the database before persistence'
);

select lives_ok(
  $xlsx_test$ select pg_temp.create_signed_workflow_plan(
       '93000000-0000-4000-8000-000000000001',
       jsonb_set(
         (select value from csv_plan_payload),
         '{steps,0,input,fileId}',
         '"94000000-0000-4000-8000-000000000003"'::jsonb
       )
     ) $xlsx_test$,
  'a signed plan can reference an XLSX attachment owned by the same task'
);

select lives_ok(
  $xlsx_test$ select pg_temp.create_signed_workflow_plan(
       '93000000-0000-4000-8000-000000000001',
       jsonb_set(
         (select value from csv_plan_payload),
         '{steps,0,input,fileId}',
         '"94000000-0000-4000-8000-000000000004"'::jsonb
       )
     ) $xlsx_test$,
  'a signed plan can reference an XLS attachment owned by the same task'
);
select throws_ok(
  $$ select pg_temp.create_signed_workflow_plan(
       '93000000-0000-4000-8000-000000000001',
       jsonb_set(
         (select value from csv_plan_payload),
         '{steps,0,input,fileId}',
         '"94000000-0000-4000-8000-000000000002"'::jsonb
       )
     ) $$,
  '22023',
  'Plan contains invalid invoice-csv-review input.',
  'the CSV review tool rejects attachments with a mismatched or unsupported file type'
);

select * from finish();
rollback;
