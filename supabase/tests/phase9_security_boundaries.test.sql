begin;

select plan(16);

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

-- Keep the authenticated SECURITY DEFINER surface explicit. Adding an RPC to
-- this list requires a separate authorization review rather than silently
-- inheriting the default function EXECUTE grant.
select ok(
  (
    select array_agg(
      p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      order by p.proname
    )
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'execute')
  ) = array[
    'archive_workspace_prompt_template(p_workspace_id uuid, p_template_id uuid, p_expected_version integer)',
    'cancel_workflow_plan_run(p_run_id uuid)',
    'create_workflow_plan(p_task_id uuid, p_plan_json text, p_signature text)',
    'create_workflow_task(p_task_id uuid, p_workspace_id uuid, p_title text, p_details text, p_initial_event jsonb)',
    'create_workspace(p_name text)',
    'decide_workflow_plan(p_plan_id uuid, p_decision text)',
    'is_workspace_member(p_workspace_id uuid)',
    'pause_workflow_plan_run(p_run_id uuid)',
    'persist_workflow_events(p_task_id uuid, p_expected_sequence integer, p_status text, p_attempt integer, p_events jsonb)',
    'record_invoice_extraction_feedback(p_task_id uuid, p_execution_id uuid, p_file_id uuid, p_submission_id uuid, p_reviewed_values jsonb)',
    'register_task_file(p_workspace_id uuid, p_task_id uuid, p_file_name text, p_storage_path text, p_content_type text)',
    'resume_workflow_plan_run(p_run_id uuid)',
    'save_workspace_prompt_template(p_workspace_id uuid, p_template_id uuid, p_expected_version integer, p_name text, p_category text, p_prompt_text text)',
    'start_workflow_plan_run(p_plan_id uuid)'
  ]::text[],
  'the authenticated SECURITY DEFINER RPC inventory is explicit and reviewed'
);

select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'execute')
      and position('auth.uid()' in p.prosrc) = 0
  ),
  'every authenticated SECURITY DEFINER RPC derives the caller from auth.uid()'
);

select ok(
  not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and has_function_privilege('authenticated', p.oid, 'execute')
      and p.proname <> 'create_workspace'
      and position('is_workspace_member' in p.prosrc) = 0
      and position('public.workspace_members' in p.prosrc) = 0
  ),
  'every authenticated SECURITY DEFINER RPC except workspace creation checks membership or directly joins workspace_members'
);

select ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and (
        has_table_privilege('anon', c.oid, 'insert')
        or has_table_privilege('anon', c.oid, 'update')
        or has_table_privilege('anon', c.oid, 'delete')
        or has_table_privilege('authenticated', c.oid, 'insert')
        or has_table_privilege('authenticated', c.oid, 'update')
        or (c.relname <> 'task_files' and has_table_privilege('authenticated', c.oid, 'delete'))
      )
  )
  and has_table_privilege('authenticated', 'public.task_files', 'delete'),
  'clients have no direct table writes except uploader-scoped task_files metadata deletion'
);

select ok(
  not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
      and c.relname in (
        'invoice_extraction_confidence_summary',
        'invoice_extraction_feedback_summary'
      )
      and not coalesce(c.reloptions, array[]::text[]) @> array['security_invoker=true']::text[]
  ),
  'invoice feedback summary views execute with caller privileges and preserve underlying RLS'
);

select ok(
  exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.task_approvals'::regclass
      and c.conname = 'task_approvals_no_self_approval'
      and c.convalidated
  )
  and not exists (
    select 1
    from public.task_approvals a
    where a.decision = 'approved'
      and a.requested_by = a.approver_id
  ),
  'the no-self-approval constraint is validated and no approved row was self-approved'
);

select * from finish();
rollback;
