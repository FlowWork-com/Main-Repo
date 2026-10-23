begin;

select plan(12);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values
  (
    'b1000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'prompt-template-owner@example.test', '', now(), now(), now()
  ),
  (
    'b1000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'prompt-template-outsider@example.test', '', now(), now(), now()
  )
on conflict (id) do nothing;

insert into public.workspaces (id, name, created_by)
values (
  'b2000000-0000-4000-8000-000000000001',
  'Prompt template workspace',
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

create temporary table prompt_template_test_state (
  id uuid not null,
  version integer not null
);
grant select, insert, update on prompt_template_test_state to authenticated;

select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
set local role authenticated;

insert into prompt_template_test_state (id, version)
select (result->>'id')::uuid, (result->>'version')::integer
from (
  select public.save_workspace_prompt_template(
    'b2000000-0000-4000-8000-000000000001',
    null,
    null,
    'Weekly KPI Summary',
    'Finance',
    'Summarize weekly revenue, costs, risks, and open questions. State assumptions explicitly.'
  ) as result
) as created;

select is(
  (select version from prompt_template_test_state),
  1,
  'a new prompt template starts at version one'
);

select is(
  (select count(*) from public.workspace_prompt_templates
   where workspace_id = 'b2000000-0000-4000-8000-000000000001' and archived_at is null),
  1::bigint,
  'the created template is visible within its workspace'
);

select is(
  (select count(*) from public.workspace_prompt_template_versions
   where workspace_id = 'b2000000-0000-4000-8000-000000000001'
     and template_id = (select id from prompt_template_test_state)),
  1::bigint,
  'version one is stored as an immutable version row'
);

select lives_ok(
  $$ select public.save_workspace_prompt_template(
       'b2000000-0000-4000-8000-000000000001',
       (select id from prompt_template_test_state),
       1,
       'Weekly KPI Summary',
       'Finance',
       'Summarize weekly revenue and costs. Flag variances and list open questions for the team.'
     ) $$,
  'a workspace member can create a new version of an existing template'
);

update prompt_template_test_state set version = 2;

select is(
  (select current_version from public.workspace_prompt_templates
   where id = (select id from prompt_template_test_state)),
  2,
  'updating a template advances its current version'
);

select is(
  (select count(*) from public.workspace_prompt_template_versions
   where template_id = (select id from prompt_template_test_state)),
  2::bigint,
  'editing preserves the previous prompt as a separate immutable version'
);

select throws_ok(
  $$ select public.save_workspace_prompt_template(
       'b2000000-0000-4000-8000-000000000001',
       (select id from prompt_template_test_state),
       1,
       'Stale edit',
       'Finance',
       'This stale edit must not overwrite the newer version.'
     ) $$,
  '40001',
  'Prompt template changed. Reload the latest version before saving.',
  'optimistic version checks reject stale edits'
);

select throws_ok(
  $$ update public.workspace_prompt_templates
     set name = 'forged direct update'
     where id = (select id from prompt_template_test_state) $$,
  '42501',
  'permission denied for table workspace_prompt_templates',
  'authenticated clients cannot bypass the audited save RPC'
);

select lives_ok(
  $$ select public.archive_workspace_prompt_template(
       'b2000000-0000-4000-8000-000000000001',
       (select id from prompt_template_test_state),
       2
     ) $$,
  'a workspace member can archive the current template version'
);

select is(
  (select count(*) from public.workspace_prompt_templates
   where workspace_id = 'b2000000-0000-4000-8000-000000000001' and archived_at is null),
  0::bigint,
  'archiving hides the template from the active list without deleting its history'
);

reset role;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000002', true);
set local role authenticated;

select is(
  (select count(*) from public.workspace_prompt_templates),
  0::bigint,
  'non-members cannot read templates from another workspace'
);

select throws_ok(
  $$ select public.save_workspace_prompt_template(
       'b2000000-0000-4000-8000-000000000001',
       null,
       null,
       'Outsider template',
       null,
       'This prompt must not be stored in someone else’s workspace.'
     ) $$,
  '42501',
  'Workspace access is required.',
  'non-members cannot create templates in another workspace'
);

select * from finish();
rollback;
