begin;

select plan(10);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  (
    'b1000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'prompt-owner@example.test', '', now(), now(), now()
  ),
  (
    'b1000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'prompt-outsider@example.test', '', now(), now(), now()
  )
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  'b2000000-0000-4000-8000-000000000001',
  'Prompt templates workspace',
  'b1000000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
values (
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'owner'
)
on conflict (workspace_id, user_id) do nothing;

create temporary table prompt_template_result (value jsonb);
grant select, insert on prompt_template_result to authenticated;

select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
set local role authenticated;

select lives_ok(
  $$ insert into prompt_template_result
     select public.save_workflow_prompt_template(
       'b2000000-0000-4000-8000-000000000001',
       null,
       'Daily invoice review',
       'Review new invoices, flag missing fields, and summarize uncertain values.',
       null
     ) $$,
  'workspace member can create a private prompt template'
);

select is(
  (select (value->>'version')::integer from prompt_template_result),
  1,
  'new templates begin at version one'
);

select lives_ok(
  $$ select public.save_workflow_prompt_template(
       'b2000000-0000-4000-8000-000000000001',
       (select (value->>'id')::uuid from prompt_template_result),
       'Daily invoice review',
       'Review new invoices and call out possible arithmetic mismatches.',
       1
     ) $$,
  'workspace member can save a new immutable template version'
);

select is(
  (select count(*) from public.workflow_prompt_template_versions
   where workspace_id = 'b2000000-0000-4000-8000-000000000001'),
  2::bigint,
  'each create or update is kept in version history'
);

select throws_ok(
  $$ select public.save_workflow_prompt_template(
       'b2000000-0000-4000-8000-000000000001',
       (select (value->>'id')::uuid from prompt_template_result),
       'Outdated edit',
       'This edit came from an old version.',
       1
     ) $$,
  '40001',
  'Prompt template changed since it was loaded. Reload before saving.',
  'optimistic version checks reject stale edits rather than overwriting newer content'
);

select lives_ok(
  $$ select public.archive_workflow_prompt_template(
       'b2000000-0000-4000-8000-000000000001',
       (select (value->>'id')::uuid from prompt_template_result),
       2
     ) $$,
  'workspace member can archive a saved prompt template'
);

select is(
  (select count(*) from public.workflow_prompt_templates
   where workspace_id = 'b2000000-0000-4000-8000-000000000001'
     and archived_at is not null),
  1::bigint,
  'archiving hides the template from normal active lists without deleting history'
);

select is(
  (select count(*) from public.workflow_prompt_template_versions
   where workspace_id = 'b2000000-0000-4000-8000-000000000001'),
  3::bigint,
  'archive action also creates an immutable history entry'
);

reset role;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select is(
  (select count(*) from public.workflow_prompt_templates),
  0::bigint,
  'non-members cannot read saved prompt templates'
);

select throws_ok(
  $$ select public.save_workflow_prompt_template(
       'b2000000-0000-4000-8000-000000000001',
       null,
       'Unauthorized prompt',
       'This should not be saved.',
       null
     ) $$,
  '42501',
  'Workspace access is required.',
  'non-members cannot create a template even when given the workspace ID'
);

select * from finish();
rollback;
