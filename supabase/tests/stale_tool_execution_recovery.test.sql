begin;

select plan(12);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values (
  'c1000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'recovery-owner@example.test', '', now(), now(), now()
)
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  'c2000000-0000-4000-8000-000000000001',
  'Execution recovery workspace',
  'c1000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'c2000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

insert into public.tasks (
  id, workspace_id, owner_id, title, details, status, attempt
) values (
  'c3000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'Recover interrupted executions', 'Verify stale execution recovery.', 'Running', 1
)
on conflict (id) do nothing;

insert into public.task_tool_executions (
  workspace_id, task_id, tool_id, tool_version, execution_id, request_id,
  requested_by, status, input, output, error, evidence, started_at, completed_at, created_at
) values
  (
    'c2000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001',
    'echo', '1.0.0',
    'c4000000-0000-4000-8000-000000000001', 'recovery-oldest',
    'c1000000-0000-4000-8000-000000000001',
    'running', '{"value":"oldest"}'::jsonb, null, null, null,
    now() - interval '2 hours', null, now() - interval '2 hours'
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001',
    'echo', '1.0.0',
    'c4000000-0000-4000-8000-000000000002', 'recovery-second',
    'c1000000-0000-4000-8000-000000000001',
    'running', '{"value":"second"}'::jsonb, null, null, null,
    now() - interval '1 hour', null, now() - interval '1 hour'
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001',
    'echo', '1.0.0',
    'c4000000-0000-4000-8000-000000000003', 'recovery-fresh',
    'c1000000-0000-4000-8000-000000000001',
    'running', '{"value":"fresh"}'::jsonb, null, null, null,
    now() - interval '1 minute', null, now() - interval '1 minute'
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001',
    'echo', '1.0.0',
    'c4000000-0000-4000-8000-000000000004', 'recovery-already-failed',
    'c1000000-0000-4000-8000-000000000001',
    'failed', '{"value":"finished earlier"}'::jsonb, null,
    '{"code":"EXECUTION_FAILED","message":"Earlier failure","retryable":false}'::jsonb,
    null,
    now() - interval '3 hours', now() - interval '3 hours' + interval '1 second',
    now() - interval '3 hours'
  )
on conflict (workspace_id, task_id, execution_id) do nothing;

set local role service_role;

select lives_ok(
  $$ select * from public.recover_stale_tool_executions(120, 1) $$,
  'service role can recover one stale execution in a bounded batch'
);

select is(
  (select status from public.task_tool_executions
   where execution_id = 'c4000000-0000-4000-8000-000000000001'),
  'failed',
  'oldest abandoned execution becomes failed'
);

select is(
  (select error->>'code' from public.task_tool_executions
   where execution_id = 'c4000000-0000-4000-8000-000000000001'),
  'EXECUTION_TIMEOUT',
  'recovery uses the established timeout error code'
);

select ok(
  (select completed_at is not null and output is null and evidence is null
   from public.task_tool_executions
   where execution_id = 'c4000000-0000-4000-8000-000000000001'),
  'recovery finalizes the row without inventing output or evidence'
);

select is(
  (select status from public.task_tool_executions
   where execution_id = 'c4000000-0000-4000-8000-000000000002'),
  'running',
  'batch limit leaves the next stale execution for a later pass'
);

select is(
  (select status from public.task_tool_executions
   where execution_id = 'c4000000-0000-4000-8000-000000000003'),
  'running',
  'recent execution is not recovered prematurely'
);

select lives_ok(
  $$ select * from public.recover_stale_tool_executions(120, 1) $$,
  'a later pass recovers the next abandoned execution'
);

select is(
  (select status from public.task_tool_executions
   where execution_id = 'c4000000-0000-4000-8000-000000000002'),
  'failed',
  'the next stale execution is recovered'
);

select is(
  (select error->>'code' from public.task_tool_executions
   where execution_id = 'c4000000-0000-4000-8000-000000000004'),
  'EXECUTION_FAILED',
  'already finalized executions are left untouched'
);

select throws_ok(
  $$ select * from public.recover_stale_tool_executions(60, 1) $$,
  '22023',
  'Recovery age must be between 120 seconds and 24 hours and batch size between 1 and 500.',
  'recovery rejects an unsafe minimum age'
);

select throws_ok(
  $$ select * from public.recover_stale_tool_executions(600, 1000) $$,
  '22023',
  'Recovery age must be between 120 seconds and 24 hours and batch size between 1 and 500.',
  'recovery rejects oversized batches'
);

reset role;
set local role authenticated;

select throws_ok(
  $$ select * from public.recover_stale_tool_executions(600, 100) $$,
  '42501',
  'permission denied for function recover_stale_tool_executions',
  'authenticated clients cannot invoke the service-only recovery function'
);

select * from finish();
rollback;
