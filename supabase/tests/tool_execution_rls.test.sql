begin;

select plan(24);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  (
    '41000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'tool-owner@example.test',
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
    'tool-reviewer@example.test',
    '',
    now(),
    now(),
    now()
  ),
  (
    '41000000-0000-4000-8000-000000000003',
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
values
  (
    '42000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000001',
    'owner'
  ),
  (
    '42000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000002',
    'member'
  );

insert into public.tasks (
  id, workspace_id, owner_id, title, details, status, attempt
) values
  (
    '43000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000001',
    'Tool test task',
    '',
    'Running',
    1
  ),
  (
    '43000000-0000-4000-8000-000000000003',
    '42000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000001',
    'Planning task',
    '',
    'Planning',
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

select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000001',
       'request-1',
       'echo',
       '1.0.0',
       '{"value":"hello"}'::jsonb,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  '42501',
  'permission denied for function claim_task_tool_execution',
  'authenticated clients cannot claim tool executions directly'
);
select throws_ok(
  $$ select public.finish_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000001',
       '{"forged":true}'::jsonb,
       null,
       null,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  '42501',
  'permission denied for function finish_task_tool_execution',
  'authenticated clients cannot finalize tool executions directly'
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

reset role;
set local role service_role;

select is(
  (select was_created from public.claim_task_tool_execution(
    '42000000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001',
    'request-1',
    'echo',
    '1.0.0',
    '{"value":"hello"}'::jsonb,
    '41000000-0000-4000-8000-000000000001'
  )),
  true,
  'the server role can claim for a verified workspace member'
);
select is(
  (select count(*) from public.task_tool_executions),
  1::bigint,
  'the claimed execution is persisted'
);
select lives_ok(
  $$ select public.finish_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000001',
       '{"value":"hello"}'::jsonb,
       null,
       '{"type":"test","reference":"echo-1"}'::jsonb,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  'the execution owner can persist a structured result'
);
select is(
  (select status from public.task_tool_executions
   where execution_id = '44000000-0000-4000-8000-000000000001'),
  'succeeded',
  'execution results are persisted'
);
select throws_ok(
  $$ select public.finish_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000001',
       '{"value":"replacement"}'::jsonb,
       null,
       '{"type":"test","reference":"echo-1"}'::jsonb,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  '23505',
  'Tool execution result is already final.',
  'a conflicting result cannot replace a finalized execution'
);
select is(
  (select was_created from public.claim_task_tool_execution(
    '42000000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000001',
    'request-1',
    'echo',
    '1.0.0',
    '{"value":"hello"}'::jsonb,
    '41000000-0000-4000-8000-000000000001'
  )),
  false,
  'the same completed request is safely replayed'
);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000001',
       'request-1',
       'echo',
       '1.0.0',
       '{"value":"different"}'::jsonb,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  '23505',
  'Execution identity was already used for a different request.',
  'the same idempotency identity cannot be reused with different input'
);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000012',
       'request-1',
       'echo',
       '1.0.0',
       '{"value":"hello"}'::jsonb,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  '23505',
  'Execution identity was already used for a different request.',
  'a request ID cannot be reused under a different execution ID'
);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000005',
       'credential-input',
       'echo',
       '1.0.0',
       '{"nested":{"service_role_key":"must-not-persist"}}'::jsonb,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  '22023',
  'Invalid tool execution request.',
  'the database rejects credential-like input keys'
);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000006',
       'credential-value',
       'echo',
       '1.0.0',
       '"bearer sample-secret-token-value"'::jsonb,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  '22023',
  'Invalid tool execution request.',
  'the database rejects common raw credential formats'
);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000007',
       'outsider-request',
       'echo',
       '1.0.0',
       '{}'::jsonb,
       '41000000-0000-4000-8000-000000000003'
     ) $$,
  '42501',
  'Workspace access is required.',
  'the server function independently rejects a nonmember actor'
);
select throws_ok(
  $$ select public.finish_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000001',
       '{"value":"hello"}'::jsonb,
       null,
       '{"type":"test","reference":"echo-1"}'::jsonb,
       '41000000-0000-4000-8000-000000000002'
     ) $$,
  '42501',
  'Tool execution access is required.',
  'a different workspace member cannot finalize the execution'
);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000002',
       '44000000-0000-4000-8000-000000000008',
       'cross-task-request',
       'echo',
       '1.0.0',
       '{}'::jsonb,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  '42501',
  'Task access is required.',
  'a workspace member cannot execute against another workspace task'
);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000003',
       '44000000-0000-4000-8000-000000000009',
       'planning-request',
       'echo',
       '1.0.0',
       '{}'::jsonb,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  '22023',
  'Task must be Running before tool execution.',
  'the database rejects claims outside the Running workflow state'
);

reset role;
select set_config('request.jwt.claim.sub', '41000000-0000-4000-8000-000000000003', true);
set local role authenticated;
select is(
  (select count(*) from public.task_tool_executions),
  0::bigint,
  'non-members cannot read execution history'
);
select throws_ok(
  $$ select public.claim_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000010',
       'direct-outsider-request',
       'echo',
       '1.0.0',
       '{}'::jsonb,
       '41000000-0000-4000-8000-000000000003'
     ) $$,
  '42501',
  'permission denied for function claim_task_tool_execution',
  'a non-member authenticated client cannot invoke the privileged claim RPC'
);

reset role;
set local role service_role;
select throws_ok(
  $$ select public.finish_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000001',
       '{"forged":true}'::jsonb,
       null,
       null,
       '41000000-0000-4000-8000-000000000003'
     ) $$,
  '42501',
  'Workspace access is required.',
  'the server function independently rejects nonmember finalization'
);

select public.claim_task_tool_execution(
  '42000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-000000000011',
  'status-change-request',
  'echo',
  '1.0.0',
  '{}'::jsonb,
  '41000000-0000-4000-8000-000000000001'
);
reset role;
update public.tasks
set status = 'Verifying'
where id = '43000000-0000-4000-8000-000000000001';
set local role service_role;
select throws_ok(
  $$ select public.finish_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000011',
       '{"value":"finished"}'::jsonb,
       null,
       null,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  '22023',
  'Task must be Running to finalize tool execution.',
  'the database rejects finalization after the task leaves Running'
);
reset role;
update public.tasks
set status = 'Running'
where id = '43000000-0000-4000-8000-000000000001';
set local role service_role;
select lives_ok(
  $$ select public.finish_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000011',
       '{"value":"finished"}'::jsonb,
       null,
       null,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  'the claimed result can be finalized while Running'
);
reset role;
update public.tasks
set status = 'Verifying'
where id = '43000000-0000-4000-8000-000000000001';
set local role service_role;
select lives_ok(
  $$ select public.finish_task_tool_execution(
       '42000000-0000-4000-8000-000000000001',
       '43000000-0000-4000-8000-000000000001',
       '44000000-0000-4000-8000-000000000011',
       '{"value":"finished"}'::jsonb,
       null,
       null,
       '41000000-0000-4000-8000-000000000001'
     ) $$,
  'an identical finalized result remains safely replayable'
);

select * from finish();
rollback;
