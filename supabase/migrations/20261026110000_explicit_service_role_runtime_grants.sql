begin;

-- Supabase local and hosted projects should expose the same explicit backend
-- privileges. These tables are accessed only by trusted Edge Functions using
-- the service-role client; RLS remains enabled for client-facing access.
grant select, update on public.workflow_plan_runs to service_role;
grant select on public.workflow_plan_step_runs to service_role;
grant select on public.workflow_plans to service_role;
grant select, update on public.task_tool_executions to service_role;

commit;
