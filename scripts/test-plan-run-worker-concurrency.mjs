import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const projectId = 'flowwork';
const containerName = `supabase_db_${projectId}`;
const containers = execFileSync('docker', [
  'ps',
  '--filter', `label=com.supabase.cli.project=${projectId}`,
  '--filter', `name=${containerName}`,
  '--format', '{{.Names}}',
], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

if (containers.length !== 1 || containers[0] !== containerName) {
  throw new Error('Expected exactly the repository-local Supabase database container.');
}

const ids = Object.fromEntries([
  'user', 'workspace', 'task', 'plan1', 'plan2', 'run1', 'run2',
  'workerA', 'workerB', 'workerC', 'oldWorker', 'execution',
].map((name) => [name, randomUUID()]));
const stepId = 'ambiguous_step';

function psql(sql, { expectFailure = false } = {}) {
  const result = spawnSync('docker', [
    'exec', containerName, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', 'postgres', '-c', sql,
  ], { encoding: 'utf8', timeout: 15_000 });
  if (expectFailure) {
    assert.notEqual(result.status, 0, 'expected the stale worker finalization to be rejected');
    return result.stderr;
  }
  if (result.status !== 0) {
    throw new Error(`Local PostgreSQL test query failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function startPsql(sql, applicationName) {
  const child = spawn('docker', [
    'exec', '-e', `PGAPPNAME=${applicationName}`, containerName,
    'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', 'postgres', '-c', sql,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => {
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
  return { child, done, output: () => stdout };
}

async function waitForActiveSession(applicationName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const active = psql(
      `select count(*) from pg_stat_activity where application_name = '${applicationName}' and state = 'active';`,
    );
    if (active === '1') return;
    await delay(25);
  }
  throw new Error('The first worker transaction was not observed active while holding its lease.');
}

async function waitForLock(applicationName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = psql(
      `select count(*) from pg_stat_activity where application_name = '${applicationName}' and wait_event_type = 'Lock';`,
    );
    if (waiting === '1') return;
    await delay(25);
  }
  throw new Error('The competing worker transaction was not observed waiting on the run row lock.');
}

const setupSql = `
begin;
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at
) values (
  '${ids.user}', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', '${ids.user}@phase9.invalid', '', now(), now(), now()
);
insert into public.workspaces (id, name, created_by)
values ('${ids.workspace}', 'Concurrency fixture', '${ids.user}');
insert into public.workspace_members (workspace_id, user_id, role)
values ('${ids.workspace}', '${ids.user}', 'owner');
insert into public.tasks (id, workspace_id, owner_id, title, details, status, attempt)
values ('${ids.task}', '${ids.workspace}', '${ids.user}', 'Concurrency fixture', '', 'Running', 1);
insert into public.workflow_plans (
  id, workspace_id, task_id, version, proposed_by, plan, decision, decided_by, decided_at
) values
  ('${ids.plan1}', '${ids.workspace}', '${ids.task}', 1, '${ids.user}',
   jsonb_build_object('id', '${ids.plan1}', 'taskId', '${ids.task}', 'validationStatus', 'valid',
     'steps', jsonb_build_array(jsonb_build_object('id', 'step_1'))),
   'accepted', '${ids.user}', now()),
  ('${ids.plan2}', '${ids.workspace}', '${ids.task}', 2, '${ids.user}',
   jsonb_build_object('id', '${ids.plan2}', 'taskId', '${ids.task}', 'validationStatus', 'valid',
     'steps', jsonb_build_array(jsonb_build_object('id', '${stepId}'))),
   'accepted', '${ids.user}', now());
insert into public.workflow_plan_runs (
  id, workspace_id, task_id, plan_id, plan_version, status, started_by,
  started_at, policy_version, max_elapsed_seconds, max_step_attempts
) values
  ('${ids.run1}', '${ids.workspace}', '${ids.task}', '${ids.plan1}', 1, 'running', '${ids.user}',
   now(), 'phase9-concurrency-test', 900, 1),
  ('${ids.run2}', '${ids.workspace}', '${ids.task}', '${ids.plan2}', 2, 'running', '${ids.user}',
   now(), 'phase9-concurrency-test', 900, 1);
insert into public.workflow_plan_step_runs (
  run_id, workspace_id, task_id, step_id, step_index, title, tool_id, tool_version,
  input, dependencies, status, attempt, execution_id, started_at
) values (
  '${ids.run1}', '${ids.workspace}', '${ids.task}', 'step_1', 0, 'Pending step',
  'echo', '1.0.0', '{"value":"safe"}'::jsonb, '[]'::jsonb,
  'pending', 0, null, null
);
update public.workflow_plan_runs
set worker_lease_owner = '${ids.oldWorker}',
    worker_lease_expires_at = clock_timestamp() - interval '1 second'
where id = '${ids.run2}';
insert into public.workflow_plan_step_runs (
  run_id, workspace_id, task_id, step_id, step_index, title, tool_id, tool_version,
  input, dependencies, status, attempt, execution_id, started_at
) values (
  '${ids.run2}', '${ids.workspace}', '${ids.task}', '${stepId}', 0, 'Interrupted step',
  'echo', '1.0.0', '{"value":"ambiguous"}'::jsonb, '[]'::jsonb,
  'running', 1, '${ids.execution}', now()
);
insert into public.task_tool_executions (
  workspace_id, task_id, tool_id, tool_version, execution_id, request_id,
  requested_by, status, input, started_at
) values (
  '${ids.workspace}', '${ids.task}', 'echo', '1.0.0', '${ids.execution}',
  'phase9-ambiguous-${ids.execution}', '${ids.user}', 'running',
  '{"value":"ambiguous"}'::jsonb, now()
);
commit;
`;

psql(setupSql);
const sessions = [];

try {
  const first = startPsql(`
    begin;
    select 'claim_a=' || (public.claim_workflow_plan_run_worker('${ids.run1}', '${ids.workerA}', 120)->>'status');
    select pg_sleep(5);
    commit;
  `, `phase9_worker_${ids.workerA}`);
  sessions.push(first);
  await waitForActiveSession(`phase9_worker_${ids.workerA}`, 5_000);

  const second = startPsql(
    `select 'claim_b=' || (public.claim_workflow_plan_run_worker('${ids.run1}', '${ids.workerB}', 120)->>'status');`,
    `phase9_worker_${ids.workerB}`,
  );
  sessions.push(second);
  await waitForLock(`phase9_worker_${ids.workerB}`, 3_000);

  const firstResult = await first.done;
  const secondResult = await second.done;
  assert.equal(firstResult.status, 0, firstResult.stderr);
  assert.equal(secondResult.status, 0, secondResult.stderr);
  assert.match(firstResult.stdout, /claim_a=running/);
  assert.match(secondResult.stdout, /claim_b=busy/);

  psql(`update public.workflow_plan_runs set worker_lease_expires_at = clock_timestamp() - interval '1 second' where id = '${ids.run1}';`);
  assert.equal(
    psql(`select 'reclaim=' || (public.claim_workflow_plan_run_worker('${ids.run1}', '${ids.workerC}', 120)->>'status');`),
    'reclaim=running',
  );
  const staleFinishError = psql(
    `select public.finish_workflow_plan_run_worker('${ids.run1}', '${ids.workerA}', null, false, 'UNKNOWN');`,
    { expectFailure: true },
  );
  assert.match(staleFinishError, /Worker lease ownership does not match/);
  assert.equal(
    psql(`select (worker_lease_owner = '${ids.workerC}' and status = 'running')::text from public.workflow_plan_runs where id = '${ids.run1}';`),
    'true',
  );

  assert.equal(
    psql(`select public.claim_workflow_plan_run_worker('${ids.run2}', '${ids.workerC}', 120)->>'reason';`),
    'expired_lease_ambiguous_step',
  );
  assert.equal(
    psql(`select (r.status = 'paused' and r.pause_reason = 'expired_lease_ambiguous_step' and s.status = 'running' and s.execution_id = '${ids.execution}' and s.attempt = 1 and s.output is null and e.status = 'running' and e.execution_id = s.execution_id)::text from public.workflow_plan_runs r join public.workflow_plan_step_runs s on s.run_id = r.id join public.task_tool_executions e on e.execution_id = s.execution_id where r.id = '${ids.run2}';`),
    'true',
  );
  assert.equal(
    psql(`select (status <> 'Completed')::text from public.tasks where id = '${ids.task}';`),
    'true',
  );

  writeSync(1, 'PASS: overlapping PostgreSQL worker claims serialize to one lease; stale completion is rejected; ambiguous execution pauses without replay or fabricated output.\n');
} finally {
  for (const session of sessions) {
    if (session.child.exitCode === null) session.child.kill('SIGTERM');
  }
  psql(`delete from public.workspaces where id = '${ids.workspace}'; delete from auth.users where id = '${ids.user}';`);
}