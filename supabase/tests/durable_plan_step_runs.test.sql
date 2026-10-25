begin;

select plan(17);

-- The workflow-plan RLS suite exercises this migration against an accepted plan.
-- This focused contract suite verifies that only the trusted role can mutate step state.
select ok(
  has_table_privilege('authenticated', 'public.workflow_plan_runs', 'select'),
  'authenticated workspace members can read run records through RLS'
);
select ok(
  not has_table_privilege('authenticated', 'public.workflow_plan_runs', 'insert'),
  'authenticated clients cannot insert run records directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.workflow_plan_step_runs', 'update'),
  'authenticated clients cannot forge step results'
);
select ok(
  has_function_privilege('authenticated', 'public.start_workflow_plan_run(uuid)', 'execute'),
  'authenticated members can request a run through the guarded RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_workflow_plan_step(uuid,text,uuid,uuid)', 'execute'),
  'authenticated clients cannot claim steps directly'
);
select ok(
  has_function_privilege('service_role', 'public.claim_workflow_plan_step(uuid,text,uuid,uuid)', 'execute'),
  'the trusted execution service can claim steps'
);
select ok(
  not has_function_privilege('authenticated', 'public.finish_workflow_plan_step(uuid,text,uuid,jsonb,jsonb,uuid)', 'execute'),
  'authenticated clients cannot forge step results through the RPC'
);
select ok(
  has_function_privilege('service_role', 'public.finish_workflow_plan_step(uuid,text,uuid,jsonb,jsonb,uuid)', 'execute'),
  'the trusted execution service can record step results'
);

select ok(
  has_table_privilege('authenticated', 'public.workflow_plan_run_events', 'select'),
  'workspace members can read sanitized run events through RLS'
);
select ok(
  not has_table_privilege('authenticated', 'public.workflow_plan_run_events', 'insert'),
  'clients cannot forge append-only run events'
);
select ok(
  has_function_privilege('authenticated', 'public.pause_workflow_plan_run(uuid)', 'execute'),
  'authenticated members can request a guarded pause'
);
select ok(
  has_function_privilege('authenticated', 'public.resume_workflow_plan_run(uuid)', 'execute'),
  'authenticated members can request a guarded resume'
);
select ok(
  has_function_privilege('authenticated', 'public.cancel_workflow_plan_run(uuid)', 'execute'),
  'authenticated members can request cancellation'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_workflow_plan_run_worker(uuid,uuid,integer)', 'execute'),
  'authenticated clients cannot claim worker leases'
);
select ok(
  has_function_privilege('service_role', 'public.claim_workflow_plan_run_worker(uuid,uuid,integer)', 'execute'),
  'only the trusted worker can claim run leases'
);
select ok(
  not has_function_privilege('authenticated', 'public.finish_workflow_plan_run_worker(uuid,uuid,text,boolean,text)', 'execute'),
  'authenticated clients cannot finalize worker state'
);
select ok(
  has_function_privilege('service_role', 'public.finish_workflow_plan_run_worker(uuid,uuid,text,boolean,text)', 'execute'),
  'the trusted worker can finalize run state'
);

select * from finish();
rollback;
