begin;

-- Keep a composite key available so correction rows cannot attach a file
-- to a different task/workspace.
create unique index if not exists task_files_workspace_task_id_key
  on public.task_files (workspace_id, task_id, id);

create table public.invoice_extraction_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  task_id uuid not null,
  execution_id uuid not null,
  file_id uuid not null,
  submission_id uuid not null,
  submission_fingerprint text not null check (submission_fingerprint ~ '^[0-9a-f]{64}$'),
  field_name text not null check (field_name in (
    'invoiceNumber',
    'invoiceDate',
    'vendor',
    'description',
    'currency',
    'subtotal',
    'taxAmount',
    'totalAmount'
  )),
  extracted_value jsonb not null check (jsonb_typeof(extracted_value) in ('string', 'number', 'null')),
  reviewed_value jsonb not null check (jsonb_typeof(reviewed_value) in ('string', 'number', 'null')),
  confidence_estimate numeric(5,4) not null check (confidence_estimate between 0 and 1),
  tool_version text not null check (char_length(trim(tool_version)) between 1 and 40),
  is_correction boolean not null,
  submitted_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (workspace_id, task_id, submission_id, field_name),
  unique (workspace_id, task_id, execution_id, field_name),
  foreign key (workspace_id, task_id)
    references public.tasks (workspace_id, id) on delete cascade,
  foreign key (workspace_id, task_id, execution_id)
    references public.task_tool_executions (workspace_id, task_id, execution_id) on delete cascade,
  foreign key (workspace_id, task_id, file_id)
    references public.task_files (workspace_id, task_id, id) on delete cascade,
  check (is_correction = (extracted_value is distinct from reviewed_value))
);

create index invoice_extraction_feedback_quality_idx
  on public.invoice_extraction_feedback (workspace_id, field_name, tool_version, created_at desc);

create index invoice_extraction_feedback_task_idx
  on public.invoice_extraction_feedback (workspace_id, task_id, created_at desc);

alter table public.invoice_extraction_feedback enable row level security;

create policy "workspace members can read invoice extraction feedback"
  on public.invoice_extraction_feedback
  for select to authenticated
  using (public.is_workspace_member(workspace_id));

revoke all on public.invoice_extraction_feedback from public, anon, authenticated, service_role;
grant select on public.invoice_extraction_feedback to authenticated;

create or replace view public.invoice_extraction_feedback_summary
with (security_invoker = true)
as
select
  workspace_id,
  field_name,
  tool_version,
  count(*)::bigint as reviewed_field_count,
  count(*) filter (where is_correction)::bigint as corrected_field_count,
  count(*) filter (where not is_correction)::bigint as unchanged_field_count,
  round(
    count(*) filter (where is_correction)::numeric / nullif(count(*), 0),
    4
  ) as observed_correction_rate,
  round(avg(confidence_estimate) filter (where is_correction), 4) as mean_confidence_when_corrected,
  round(avg(confidence_estimate) filter (where not is_correction), 4) as mean_confidence_when_unchanged,
  count(*) filter (
    where reviewed_value = 'null'::jsonb
  )::bigint as reviewed_as_missing_count
from public.invoice_extraction_feedback
group by workspace_id, field_name, tool_version;

revoke all on public.invoice_extraction_feedback_summary from public, anon;
grant select on public.invoice_extraction_feedback_summary to authenticated;

create or replace function public.record_invoice_extraction_feedback(
  p_task_id uuid,
  p_execution_id uuid,
  p_file_id uuid,
  p_submission_id uuid,
  p_reviewed_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_execution public.task_tool_executions%rowtype;
  v_task public.tasks%rowtype;
  v_file public.task_files%rowtype;
  v_submission_fingerprint text;
  v_existing_fingerprint text;
  v_existing_submission_id uuid;
  v_existing_count integer := 0;
  v_key_count integer := 0;
  v_field text;
  v_field_json jsonb;
  v_extracted jsonb;
  v_confidence_json jsonb;
  v_confidence numeric;
  v_tool_version text;
  v_value_type text;
  v_max_length integer;
  v_inserted_count integer := 0;
  v_required_fields constant text[] := array[
    'invoiceNumber', 'invoiceDate', 'vendor', 'description',
    'currency', 'subtotal', 'taxAmount', 'totalAmount'
  ];
begin
  if v_user_id is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  if p_task_id is null or p_execution_id is null or p_file_id is null
    or p_submission_id is null or p_reviewed_values is null
    or jsonb_typeof(p_reviewed_values) is distinct from 'object'
    or pg_column_size(p_reviewed_values) > 16384
    or public.tool_data_contains_credentials(p_reviewed_values) then
    raise exception 'Invalid invoice extraction review.' using errcode = '22023';
  end if;
  select count(*) into v_key_count from jsonb_object_keys(p_reviewed_values);
  if v_key_count <> 8
    or not (p_reviewed_values ?& v_required_fields)
    or exists (
      select 1 from jsonb_object_keys(p_reviewed_values) as keys(value)
      where not (keys.value = any(v_required_fields))
    ) then
    raise exception 'All eight supported invoice fields must be reviewed.' using errcode = '22023';
  end if;

  select t.* into v_task
  from public.tasks t
  where t.id = p_task_id
  for update;
  if not found or not public.is_workspace_member(v_task.workspace_id) then
    raise exception 'Task access is required.' using errcode = '42501';
  end if;
  v_workspace_id := v_task.workspace_id;

  select e.* into v_execution
  from public.task_tool_executions e
  where e.workspace_id = v_workspace_id
    and e.task_id = p_task_id
    and e.execution_id = p_execution_id
    and e.tool_id = 'invoice-document-extract'
    and e.status = 'succeeded'
  for share;
  if not found
    or v_execution.input->>'fileId' is distinct from p_file_id::text
    or v_execution.output->>'fileId' is distinct from p_file_id::text
    or jsonb_typeof(v_execution.output->'fields') is distinct from 'object' then
    raise exception 'A successful invoice extraction for this file is required.' using errcode = '22023';
  end if;

  select f.* into v_file
  from public.task_files f
  where f.workspace_id = v_workspace_id
    and f.task_id = p_task_id
    and f.id = p_file_id
    and (
      (f.file_name ~* '[.]pdf$' and lower(coalesce(f.content_type, '')) = 'application/pdf')
      or (f.file_name ~* '[.](jpg|jpeg)$' and lower(coalesce(f.content_type, '')) = 'image/jpeg')
      or (f.file_name ~* '[.]png$' and lower(coalesce(f.content_type, '')) = 'image/png')
    );
  if not found then
    raise exception 'Invoice attachment access is required.' using errcode = '42501';
  end if;

  v_submission_fingerprint := encode(extensions.digest(p_reviewed_values::text, 'sha256'), 'hex');
  select count(*), min(f.submission_fingerprint), min(f.submission_id)
    into v_existing_count, v_existing_fingerprint, v_existing_submission_id
  from public.invoice_extraction_feedback f
  where f.workspace_id = v_workspace_id
    and f.task_id = p_task_id
    and f.execution_id = p_execution_id;

  if v_existing_count > 0 then
    if v_existing_count = 8
      and v_existing_submission_id = p_submission_id
      and v_existing_fingerprint = v_submission_fingerprint then
      return jsonb_build_object(
        'submissionId', p_submission_id,
        'recordedFieldCount', v_existing_count,
        'idempotentReplay', true
      );
    end if;
    if v_existing_submission_id = p_submission_id then
      raise exception 'Invoice feedback submission ID was reused with different values.' using errcode = '23505';
    end if;
    raise exception 'This invoice extraction has already been reviewed.' using errcode = '23505';
  end if;

  v_tool_version := v_execution.tool_version;
  foreach v_field in array v_required_fields loop
    v_field_json := v_execution.output->'fields'->v_field;
    if jsonb_typeof(v_field_json) is distinct from 'object'
      or jsonb_typeof(v_field_json->'value') not in ('string', 'number', 'null')
      or jsonb_typeof(v_field_json->'confidenceEstimate') is distinct from 'number' then
      raise exception 'The saved extraction contains an invalid field report.' using errcode = '22023';
    end if;

    v_extracted := v_field_json->'value';
    v_confidence_json := v_field_json->'confidenceEstimate';
    v_confidence := (v_confidence_json #>> '{}')::numeric;
    if v_confidence < 0 or v_confidence > 1 then
      raise exception 'The saved extraction contains invalid confidence.' using errcode = '22023';
    end if;

    v_field_json := p_reviewed_values->v_field;
    if v_field_json is null then
      raise exception 'All eight supported invoice fields must be reviewed.' using errcode = '22023';
    end if;

    if v_field in ('invoiceNumber', 'invoiceDate', 'vendor', 'description', 'currency') then
      if jsonb_typeof(v_field_json) not in ('string', 'null') then
        raise exception 'A reviewed invoice text field has the wrong type.' using errcode = '22023';
      end if;
      if jsonb_typeof(v_field_json) = 'string' and char_length(v_field_json #>> '{}') > 500 then
        raise exception 'A reviewed invoice text field is too long.' using errcode = '22023';
      end if;
      if v_field = 'invoiceDate' and jsonb_typeof(v_field_json) = 'string'
        and (v_field_json #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'Invoice date must use YYYY-MM-DD or be marked missing.' using errcode = '22023';
      end if;
      if v_field = 'currency' and jsonb_typeof(v_field_json) = 'string'
        and (v_field_json #>> '{}') !~ '^[A-Za-z]{3}$' then
        raise exception 'Currency must be a three-letter code or be marked missing.' using errcode = '22023';
      end if;
    else
      if jsonb_typeof(v_field_json) not in ('number', 'null') then
        raise exception 'A reviewed invoice amount field has the wrong type.' using errcode = '22023';
      end if;
      if jsonb_typeof(v_field_json) = 'number'
        and abs((v_field_json #>> '{}')::numeric) > 1000000000000 then
        raise exception 'A reviewed invoice amount is out of range.' using errcode = '22023';
      end if;
    end if;

    insert into public.invoice_extraction_feedback (
      workspace_id, task_id, execution_id, file_id, submission_id,
      submission_fingerprint, field_name, extracted_value, reviewed_value,
      confidence_estimate, tool_version, is_correction, submitted_by
    ) values (
      v_workspace_id, p_task_id, p_execution_id, p_file_id, p_submission_id,
      v_submission_fingerprint, v_field, v_extracted, v_field_json,
      v_confidence, v_tool_version, v_extracted is distinct from v_field_json, v_user_id
    );
    v_inserted_count := v_inserted_count + 1;
  end loop;

  return jsonb_build_object(
    'submissionId', p_submission_id,
    'recordedFieldCount', v_inserted_count,
    'idempotentReplay', false
  );
end;
$$;

revoke all on function public.record_invoice_extraction_feedback(uuid, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_invoice_extraction_feedback(uuid, uuid, uuid, uuid, jsonb)
  to authenticated;

comment on table public.invoice_extraction_feedback is
  'Workspace-scoped human review feedback for saved invoice extraction runs. Unchanged values mean the reviewer accepted the extracted field; correction rates measure observed review outcomes, not independently verified accuracy.';

commit;
