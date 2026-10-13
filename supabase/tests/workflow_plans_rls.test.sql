begin;

select plan(19);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  (
    '61000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'plan-owner@example.test', '', now(), now(), now()
  ),
  (
    '61000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'plan-outsider@example.test', '', now(), now(), now()
  )
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  '62000000-0000-4000-8000-000000000001',
  'Plan test workspace',
  '61000000-0000-4000-8000-000000000001'
);
insert into public.workspace_members (workspace_id, user_id, role)
values (
  '62000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000001',
  'owner'
);
insert into public.tasks (
  id, workspace_id, owner_id, title, details, status, attempt
) values (
  '63000000-0000-4000-8000-000000000001',
  '62000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000001',
  'Plan test task', '', 'Planning', 1
);

create temporary table plan_test_payload (value jsonb);
insert into plan_test_payload values (jsonb_build_object(
  'id', 'ignored-by-server',
  'taskId', '63000000-0000-4000-8000-000000000001',
  'goal', 'Uppercase hello.',
  'summary', 'Transform the supplied text.',
  'steps', jsonb_build_array(jsonb_build_object(
    'id', 'step_1',
    'title', 'Transform text',
    'description', 'Apply the text transform tool.',
    'toolId', 'text-transform',
    'toolVersion', '1.0.0',
    'input', jsonb_build_object('operation', 'uppercase', 'text', 'hello'),
    'dependencies', '[]'::jsonb,
    'expectedOutcome', 'Uppercase output.',
    'verificationCriteria', 'The output is uppercase.',
    'validation', jsonb_build_object('valid', false, 'blockingReasons', jsonb_build_array('forged'))
  )),
  'dependencies', '[]'::jsonb,
  'createdAt', now()::text,
  'version', 999,
  'validationStatus', 'invalid',
  'limitations', '[]'::jsonb
));

grant select on plan_test_payload to authenticated;

select vault.create_secret(
  'plan-test-signing-key-at-least-32-characters-long',
  'flowwork-plan-signing-key',
  'Temporary signing key for workflow plan database tests'
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
          'plan-test-signing-key-at-least-32-characters-long'::text,
          'sha256'::text
        ),
        'hex'
      )
  );
$$;

select set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select pg_temp.create_signed_workflow_plan(
  '63000000-0000-4000-8000-000000000001',
  (select value from plan_test_payload)
);
select is(
  (select count(*) from public.workflow_plans),
  1::bigint,
  'a workspace member can persist a validated plan proposal'
);
select is(
  (select plan->>'validationStatus' from public.workflow_plans limit 1),
  'valid',
  'the database recomputes plan validation status'
);
select is(
  (select plan->'steps'->0->'validation'->>'valid' from public.workflow_plans limit 1),
  'true',
  'the database overwrites model-provided validation flags'
);
select lives_ok(
  $$ select public.decide_workflow_plan(
       (select id from public.workflow_plans limit 1), 'accepted'
     ) $$,
  'a member can accept an existing valid proposal'
);
select is(
  (select decision from public.workflow_plans limit 1),
  'accepted',
  'the acceptance decision is durable'
);
select is(
  (select status from public.tasks where id = '63000000-0000-4000-8000-000000000001'),
  'Planning',
  'accepting a plan does not advance workflow status'
);
select is(
  (select count(*) from public.task_tool_executions),
  0::bigint,
  'accepting a plan never creates a tool execution'
);
reset role;
update public.tasks
set status = 'Running'
where id = '63000000-0000-4000-8000-000000000001';
set local role authenticated;
select lives_ok(
  $$ select public.decide_workflow_plan(
       (select id from public.workflow_plans limit 1), 'accepted'
     ) $$,
  'repeating the accepted decision remains idempotent after workflow progress'
);
reset role;
update public.tasks
set status = 'Planning'
where id = '63000000-0000-4000-8000-000000000001';
set local role authenticated;
select throws_ok(
  $$ select public.decide_workflow_plan(
       (select id from public.workflow_plans limit 1), 'rejected'
     ) $$,
  '23505',
  'The plan decision is already final.',
  'a final plan decision cannot be reversed'
);
select throws_ok(
  $$ insert into public.workflow_plans (workspace_id, task_id, version, proposed_by, plan)
     values (
       '62000000-0000-4000-8000-000000000001',
       '63000000-0000-4000-8000-000000000001', 9,
       '61000000-0000-4000-8000-000000000001', '{}'::jsonb
     ) $$,
  '42501',
  'permission denied for table workflow_plans',
  'authenticated clients cannot write plan records directly'
);
select throws_ok(
  $$ select public.create_workflow_plan(
       '63000000-0000-4000-8000-000000000001',
       (select value from plan_test_payload)::text,
       repeat('0', 64)
     ) $$,
  '42501',
  'Plan proposal signature is invalid.',
  'browser callers cannot forge a server-signed proposal'
);

select set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000002', true);
select is(
  (select count(*) from public.workflow_plans),
  0::bigint,
  'non-members cannot read plan records'
);
select throws_ok(
  $$ select public.decide_workflow_plan(
       '00000000-0000-4000-8000-000000000001', 'accepted'
     ) $$,
  '42501',
  'Plan access is required.',
  'non-members cannot make plan decisions'
);

select set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$ select pg_temp.create_signed_workflow_plan(
       '63000000-0000-4000-8000-000000000001',
       jsonb_set((select value from plan_test_payload), '{steps,0,toolId}', '"missing-tool"'::jsonb)
     ) $$,
  '22023',
  'Plan contains an unsupported tool.',
  'unknown tools are rejected at the persistence boundary'
);
select throws_ok(
  $$ select pg_temp.create_signed_workflow_plan(
       '63000000-0000-4000-8000-000000000001',
       jsonb_set(
         (select value from plan_test_payload),
         '{steps,0,input}',
         '{"operation":"uppercase","text":"hello","taskId":"63000000-0000-4000-8000-000000000099"}'::jsonb
       )
     ) $$,
  '22023',
  'Invalid plan step.',
  'cross-task references in plan inputs are rejected'
);
select throws_ok(
  $$ select pg_temp.create_signed_workflow_plan(
       '63000000-0000-4000-8000-000000000001',
       jsonb_set(
         (select value from plan_test_payload),
         '{steps}',
         jsonb_build_array(
           jsonb_set((select value->'steps'->0 from plan_test_payload), '{dependencies}', '["step_2"]'::jsonb),
           jsonb_build_object(
             'id', 'step_2',
             'title', 'Second step',
             'description', 'Depends on the first step.',
             'toolId', 'echo',
             'toolVersion', '1.0.0',
             'input', jsonb_build_object('value', 'second'),
             'dependencies', '["step_1"]'::jsonb,
             'expectedOutcome', 'Second output.',
             'verificationCriteria', 'Second output exists.'
           )
         )
       )
     ) $$,
  '22023',
  'Plan dependency graph contains a cycle.',
  'cyclic dependencies are rejected'
);
select lives_ok(
  $$ select pg_temp.create_signed_workflow_plan(
       '63000000-0000-4000-8000-000000000001',
       jsonb_set(
         jsonb_set((select value from plan_test_payload), '{goal}', '"Send email to the team."'::jsonb),
         '{steps}',
         '[]'::jsonb
       )
     ) $$,
  'unsupported requests can be saved with explicit limitations'
);
select is(
  (select plan->>'validationStatus' from public.workflow_plans order by version desc limit 1),
  'invalid',
  'unsupported capabilities are not marked executable'
);
select throws_ok(
  $$ select public.decide_workflow_plan(
       (select id from public.workflow_plans order by version desc limit 1), 'accepted'
     ) $$,
  '22023',
  'An invalid plan cannot be accepted.',
  'unsupported plans cannot be accepted'
);

select * from finish();
rollback;