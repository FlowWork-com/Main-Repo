begin;

select plan(10);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values (
  '71000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'phase6-owner@example.test', '', now(), now(), now()
)
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  '72000000-0000-4000-8000-000000000001',
  'Phase 6 worker test workspace',
  '71000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  '72000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000001',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

insert into public.tasks (
  id, workspace_id, owner_id, title, details, status, attempt
) values (
  '73000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000001',
  'Bounded worker test', '', 'Running', 1
)
on conflict (id) do nothing;

insert into public.workflow_plans (
  id, workspace_id, task_id, version, proposed_by, plan, decision, decided_by, decided_at
) values (
  '74000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000001',
  1,
  '71000000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'id', '74000000-0000-4000-8000-000000000001',
    'taskId', '73000000-0000-4000-8000-000000000001',
    'goal', 'Uppercase hello.',
    'summary', 'Transform text.',
    'validationStatus', 'valid',
    'steps', jsonb_build_array(jsonb_build_object(
      'id', 'step_1',
      'title', 'Transform text',
      'toolId', 'text-transform',
      'toolVersion', '1.0.0',
      'input', jsonb_build_object('operation', 'uppercase', 'text', 'hello'),
      'dependencies', '[]'::jsonb
    ))
  ),
  'accepted',
  '71000000-0000-4000-8000-000000000001',
  now()
)
on conflict (id) do nothing;

create temporary table phase6_test_run (id uuid);
grant select, insert on phase6_test_run to authenticated, service_role;
select set_config('request.jwt.claim.sub', '71000000-0000-4000-8000-000000000001', true);
set local role authenticated;
insert into phase6_test_run
select (public.start_workflow_plan_run('74000000-0000-4000-8000-000000000001')->>'id')::uuid;

select is(
  (select status from public.workflow_plan_runs where id = (select id from phase6_test_run)),
  'running',
  'accepted plan run is durably available to a worker'
);

reset role;
set local role service_role;
select is(
  public.claim_workflow_plan_run_worker((select id from phase6_test_run), '75000000-0000-4000-8000-000000000001', 120)->>'status',
  'running',
  'first worker atomically claims the run lease'
);
select is(
  public.claim_workflow_plan_run_worker((select id from phase6_test_run), '75000000-0000-4000-8000-000000000002', 120)->>'status',
  'busy',
  'a concurrent worker cannot claim an unexpired lease'
);

reset role;
set local role authenticated;
select is(
  public.pause_workflow_plan_run((select id from phase6_test_run))->>'status',
  'running',
  'authorized pause request waits for the active worker lease to finish'
);

reset role;
set local role service_role;
select is(
  public.finish_workflow_plan_run_worker(
    (select id from phase6_test_run),
    '75000000-0000-4000-8000-000000000001',
    null,
    true,
    null
  )->>'status',
  'paused',
  'worker completion releases a lease without undoing a concurrent pause'
);

reset role;
set local role authenticated;
select is(
  public.resume_workflow_plan_run((select id from phase6_test_run))->>'status',
  'running',
  'a clean user-paused run can resume'
);

reset role;
set local role service_role;
select is(
  public.claim_workflow_plan_run_worker((select id from phase6_test_run), '75000000-0000-4000-8000-000000000003', 120)->>'status',
  'running',
  'resumed run can be claimed again'
);
select is(
  public.claim_workflow_plan_step(
    (select id from phase6_test_run),
    'step_1',
    '76000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000001'
  )->>'status',
  'running',
  'worker can claim the first dependency-ready step'
);
update public.workflow_plan_runs
set worker_lease_expires_at = clock_timestamp() - interval '1 second'
where id = (select id from phase6_test_run);

select is(
  public.claim_workflow_plan_run_worker((select id from phase6_test_run), '75000000-0000-4000-8000-000000000004', 120)->>'reason',
  'expired_lease_ambiguous_step',
  'expired lease with an in-flight step pauses instead of replaying it'
);

reset role;
set local role authenticated;
select is(
  public.cancel_workflow_plan_run((select id from phase6_test_run))->>'status',
  'cancelled',
  'authorized member can cancel a paused run'
);

reset role;
select * from finish();
rollback;
