begin;

select plan(14);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  (
    '41000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'tool-member@example.test',
    '',
    now(),
    now(),
    now()
  ),
  (
    '41000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'tool-outsider@example.test',
    '',
    now(),
    now(),
    now()
  )
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  '42000000-0000-4000-8000-000000000001',
  'Tool execution workspace',
  '41000000-0000-4000-8000-000000000001'
);

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '42000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001',
  'owner'
);

insert into public.tasks (
  id, workspace_id, owner_id, title, details, status, attempt
) values (
  '43000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001',
  'Tool test task',
  '',
  'Running',
  1
);

insert into public.workspaces (id, name, created_by)
values (
  '42000000-0000-4000-8000-000000000002',
  'Other workspace',
  '41000000-0000-4000-8000-000000000001'
);
insert into public.tasks (
  id, workspace_id, owner_id, title, details, status, attempt
) values (
  '43000000-0000-4000-8000-000000000002',
  '42000000-0000-4000-8000-000000000002',
  '41000000-0000-4000-8000-000000000001',
  'Cross-workspace task',
  '',
  'Running',
  1
);

select set_config('request.jwt.claim.sub', '41000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select is(
  (select was_created from public.claim_task_tool_execution(
    '42000000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001',
    'request-1',
    'echo',
    '1.0.0',
    '{"value":"hello"}'::jsonb
  )),
  true,
  'a workspace member can claim a tool execution'
);
select is(
  (select count(*) from public.task_tool_executions),
  1::bigint,
  'workspace members can read their execution history'
);
select lives_ok(
  $$ select public.finish_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000001',
       '{"value":"hello"}'::jsonb,
       null,
       '{"type":"test","reference":"echo-1"}'::jsonb
     ) $$,
  'the authenticated execution owner can record a result'
);
select is(
  (select status from public.task_tool_executions
   where execution_id = '44000000-0000-4000-8000-000000000001'),
  'succeeded',
  'execution results are persisted'
);
select is(
  (select was_created from public.claim_task_tool_execution(
    '42000000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001',
    'request-1',
    'echo',
    '1.0.0',
    '{"value":"hello"}'::jsonb
  )),
  false,
  'the same execution request is idempotently replayed'
);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000001',
       'request-1',
       'echo',
       '1.0.0',
       '{"value":"different"}'::jsonb
     ) $$,
  '23505',
  'Execution identity was already used for a different request.',
  'the same idempotency identity cannot be reused with different input'
);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000005',
       'credential-input',
       'echo',
       '1.0.0',
       '{"nested":{"service_role_key":"must-not-persist"}}'::jsonb
     ) $$,
  '22023',
  'Invalid tool execution request.',
  'the database rejects credential-like input keys even when RPC is called directly'
);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000006',
       'credential-value',
       'echo',
       '1.0.0',
       '"Bearer abcdefghijklmnop"'::jsonb
     ) $$,
  '22023',
  'Invalid tool execution request.',
  'the database rejects common raw credential formats'
);
select throws_ok(
  $$ insert into public.task_tool_executions (
       workspace_id, task_id, tool_id, tool_version, execution_id,
       request_id, requested_by, status, input
     ) values (
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       'echo',
       '1.0.0',
       '44000000-0000-4000-8000-000000000002',
       'request-2',
       '41000000-0000-4000-8000-000000000001',
       'running',
       '{}'::jsonb
     ) $$,
  '42501',
  'permission denied for table task_tool_executions',
  'authenticated clients cannot directly insert execution records'
);
select throws_ok(
  $$ update public.task_tool_executions set workspace_id = '42000000-0000-4000-8000-000000000002' $$,
  '42501',
  'permission denied for table task_tool_executions',
  'authenticated clients cannot mutate execution linkage or history'
);

select set_config('request.jwt.claim.sub', '41000000-0000-4000-8000-000000000002', true);
select is(
  (select count(*) from public.task_tool_executions),
  0::bigint,
  'non-members cannot read execution history'
);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000003',
       'outsider-request',
       'echo',
       '1.0.0',
       '{}'::jsonb
     ) $$,
  '42501',
  'Workspace access is required.',
  'non-members cannot claim workspace executions'
);
select set_config('request.jwt.claim.sub', '41000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000002',
       '44000000-0000-4000-8000-000000000004',
       'cross-task-request',
       'echo',
       '1.0.0',
       '{}'::jsonb
     ) $$,
  '42501',
  'Task access is required.',
  'a workspace member cannot execute against another workspace task'
);
select set_config('request.jwt.claim.sub', '41000000-0000-4000-8000-000000000002', true);
select throws_ok(
  $$ select public.finish_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000001',
       '{"forged":true}'::jsonb,
       null,
       null
     ) $$,
  '42501',
  'Workspace access is required.',
  'non-members cannot finish executions'
);

select * from finish();
rollback;
