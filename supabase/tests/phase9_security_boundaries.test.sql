begin;

select plan(10);

select ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
  ),
  'every base or partitioned table in the exposed public schema has RLS enabled'
);

select ok(
  not has_table_privilege('anon', 'public.google_workspace_oauth_states', 'select')
  and not has_table_privilege('anon', 'public.google_workspace_oauth_states', 'insert')
  and not has_table_privilege('anon', 'public.google_workspace_oauth_states', 'update')
  and not has_table_privilege('anon', 'public.google_workspace_oauth_states', 'delete')
  and not has_table_privilege('authenticated', 'public.google_workspace_oauth_states', 'select')
  and not has_table_privilege('authenticated', 'public.google_workspace_oauth_states', 'insert')
  and not has_table_privilege('authenticated', 'public.google_workspace_oauth_states', 'update')
  and not has_table_privilege('authenticated', 'public.google_workspace_oauth_states', 'delete'),
  'OAuth state and PKCE references are not directly accessible to anon or authenticated clients'
);

select ok(
  has_table_privilege('service_role', 'public.google_workspace_oauth_states', 'select')
  and has_table_privilege('service_role', 'public.google_workspace_oauth_states', 'insert')
  and has_table_privilege('service_role', 'public.google_workspace_oauth_states', 'update')
  and has_table_privilege('service_role', 'public.google_workspace_oauth_states', 'delete'),
  'the trusted service role retains the OAuth state operations required by the Edge Function'
);

select ok(
  not has_table_privilege('anon', 'public.workspace_finnlp_connections', 'select')
  and not has_table_privilege('anon', 'public.workspace_finnlp_connections', 'insert')
  and not has_table_privilege('anon', 'public.workspace_finnlp_connections', 'update')
  and not has_table_privilege('anon', 'public.workspace_finnlp_connections', 'delete')
  and not has_table_privilege('authenticated', 'public.workspace_finnlp_connections', 'select')
  and not has_table_privilege('authenticated', 'public.workspace_finnlp_connections', 'insert')
  and not has_table_privilege('authenticated', 'public.workspace_finnlp_connections', 'update')
  and not has_table_privilege('authenticated', 'public.workspace_finnlp_connections', 'delete'),
  'FinNLP connection metadata and secret references are not directly accessible to client roles'
);

select ok(
  has_table_privilege('service_role', 'public.workspace_finnlp_connections', 'select')
  and has_table_privilege('service_role', 'public.workspace_finnlp_connections', 'insert')
  and has_table_privilege('service_role', 'public.workspace_finnlp_connections', 'update')
  and has_table_privilege('service_role', 'public.workspace_finnlp_connections', 'delete'),
  'the trusted service role retains the FinNLP connection operations required by the Edge Function'
);

select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and has_function_privilege('anon', p.oid, 'execute')
  ),
  'no SECURITY DEFINER function in public is executable by anon or via a PUBLIC grant'
);

select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and coalesce(array_to_string(p.proconfig, ','), '') not ilike '%search_path=%'
  ),
  'every SECURITY DEFINER function in public pins its search_path'
);

select ok(
  not has_function_privilege('anon', 'public.connect_finnlp_connection(uuid,uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.connect_finnlp_connection(uuid,uuid,text)', 'execute')
  and not has_function_privilege('anon', 'public.read_finnlp_api_key(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.read_finnlp_api_key(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.disconnect_finnlp_connection(uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.disconnect_finnlp_connection(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.store_google_workspace_secret(text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.store_google_workspace_secret(text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.read_google_workspace_secret(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.read_google_workspace_secret(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.delete_google_workspace_secret(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.delete_google_workspace_secret(uuid)', 'execute'),
  'provider and OAuth secret management RPCs remain service-role-only'
);

select ok(
  has_function_privilege('service_role', 'public.connect_finnlp_connection(uuid,uuid,text)', 'execute')
  and has_function_privilege('service_role', 'public.read_finnlp_api_key(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.disconnect_finnlp_connection(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.store_google_workspace_secret(text,text,text)', 'execute')
  and has_function_privilege('service_role', 'public.read_google_workspace_secret(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.delete_google_workspace_secret(uuid)', 'execute'),
  'the trusted service role can call the provider and OAuth secret RPCs'
);

select ok(
  has_function_privilege('authenticated', 'public.create_workflow_plan(uuid,text,text)', 'execute')
  and has_function_privilege('authenticated', 'public.decide_workflow_plan(uuid,text)', 'execute')
  and has_function_privilege('authenticated', 'public.start_workflow_plan_run(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.pause_workflow_plan_run(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.resume_workflow_plan_run(uuid)', 'execute'),
  'the authenticated workflow RPC surface remains available behind its in-function authorization checks'
);

select * from finish();
rollback;
