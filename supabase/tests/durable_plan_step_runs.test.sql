begin;

select plan(8);

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

select * from finish();
rollback;
