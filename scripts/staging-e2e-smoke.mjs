#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { URL } from 'node:url';

/* global fetch, AbortSignal */

const PROJECT_REF = 'nhvmeahmwywhaxtnuehr';
const EXPECTED_TASK_TITLE = 'STAGING E2E: dry-run workflow verification';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_RUN_ID = '00000000-0000-4000-8000-000000000999';
const DUMMY_FILE_ID = '00000000-0000-4000-8000-000000000001';

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Required GitHub Actions secret/input is missing: ' + name);
  }
  return value.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pass(message) {
  process.stdout.write('PASS ' + message + '\n');
}

function readCode(payload) {
  if (!payload || typeof payload !== 'object') return 'UNKNOWN';
  if (payload.error && typeof payload.error === 'object' && typeof payload.error.code === 'string') {
    return payload.error.code;
  }
  if (typeof payload.code === 'string') return payload.code;
  return 'UNKNOWN';
}

function readSafeMessage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const error = payload.error && typeof payload.error === 'object' ? payload.error : null;
  const message = error && typeof error.message === 'string'
    ? error.message
    : typeof payload.message === 'string' ? payload.message : null;
  if (!message) return null;
  // This function is intended to print the adapter's fixed, sanitized public message only.
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

async function postFunction(baseUrl, anonKey, functionName, payload, accessToken) {
  const headers = {
    apikey: anonKey,
    'content-type': 'application/json',
  };
  if (accessToken) headers.authorization = 'Bearer ' + accessToken;

  const response = await fetch(baseUrl + '/functions/v1/' + functionName, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });

  let body = null;
  try {
    const raw = await response.text();
    if (raw.length <= 200_000) body = JSON.parse(raw);
  } catch {
    body = null;
  }
  return { response: response, body: body };
}

async function main() {
  const rawUrl = requiredEnv('STAGING_SUPABASE_URL');
  const anonKey = requiredEnv('STAGING_SUPABASE_ANON_KEY');
  const email = requiredEnv('STAGING_TEST_USER_EMAIL');
  const password = requiredEnv('STAGING_TEST_USER_PASSWORD');
  const expectedUserId = requiredEnv('STAGING_EXPECTED_USER_ID');
  const workspaceId = requiredEnv('STAGING_WORKSPACE_ID');
  const taskId = requiredEnv('STAGING_TASK_ID');

  const parsedUrl = new URL(rawUrl);
  assert(parsedUrl.protocol === 'https:' &&
    parsedUrl.hostname === PROJECT_REF + '.supabase.co' &&
    parsedUrl.pathname === '/' &&
    !parsedUrl.search && !parsedUrl.hash,
  'Refusing to run: STAGING_SUPABASE_URL must point to the approved FlowWork staging project.');
  assert(UUID_PATTERN.test(expectedUserId), 'STAGING_EXPECTED_USER_ID must be a UUID.');
  assert(UUID_PATTERN.test(workspaceId), 'STAGING_WORKSPACE_ID must be a UUID.');
  assert(UUID_PATTERN.test(taskId), 'STAGING_TASK_ID must be a UUID.');

  const baseUrl = parsedUrl.origin;
  const client = createClient(baseUrl, anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  try {
    // These requests intentionally carry no user bearer token. They must remain denied.
    const unauthenticatedCases = [
      ['plan-workflow', { taskId: taskId, goal: 'A harmless staging authentication smoke test.' }],
      ['execute-tool', {
        taskId: taskId,
        executionId: randomUUID(),
        requestId: 'staging-unauthenticated-' + randomUUID(),
        toolId: 'invoice-document-extract',
        toolVersion: '1.0.0',
        input: { fileId: DUMMY_FILE_ID },
      }],
      ['advance-plan-run', { planRunId: UNKNOWN_RUN_ID }],
      ['finnlp-integration', { action: 'status', workspaceId: workspaceId }],
    ];

    for (const testCase of unauthenticatedCases) {
      const result = await postFunction(baseUrl, anonKey, testCase[0], testCase[1], null);
      assert(result.response.status === 401,
        testCase[0] + ' must reject requests without a user session (HTTP 401 expected; received ' +
        result.response.status + ').');
    }
    pass('all four Edge Functions reject unauthenticated requests');

    const signIn = await client.auth.signInWithPassword({ email: email, password: password });
    assert(!signIn.error && signIn.data && signIn.data.user && signIn.data.session &&
      typeof signIn.data.session.access_token === 'string',
    'Test-user sign-in failed. Check the staging email/password secrets and email confirmation.');
    const userId = signIn.data.user.id;
    const accessToken = signIn.data.session.access_token;
    assert(userId === expectedUserId, 'Signed-in identity does not match STAGING_EXPECTED_USER_ID.');
    const verifiedUser = await client.auth.getUser();
    assert(!verifiedUser.error && verifiedUser.data.user && verifiedUser.data.user.id === expectedUserId,
      'Supabase could not verify the signed-in test user.');
    pass('test-user authentication and identity verification');

    const workspaceResult = await client.from('workspaces')
      .select('id, name, created_by')
      .eq('id', workspaceId)
      .maybeSingle();
    assert(!workspaceResult.error && workspaceResult.data &&
      workspaceResult.data.id === workspaceId &&
      workspaceResult.data.created_by === expectedUserId,
    'The signed-in test user cannot read the expected workspace under RLS.');

    const membershipResult = await client.from('workspace_members')
      .select('workspace_id, user_id, role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', expectedUserId)
      .maybeSingle();
    assert(!membershipResult.error && membershipResult.data &&
      membershipResult.data.role === 'owner',
    'The signed-in test user is not an owner of the configured staging workspace.');

    const taskResult = await client.from('tasks')
      .select('id, workspace_id, owner_id, title, details, status')
      .eq('id', taskId)
      .maybeSingle();
    assert(!taskResult.error && taskResult.data &&
      taskResult.data.id === taskId &&
      taskResult.data.workspace_id === workspaceId &&
      taskResult.data.owner_id === expectedUserId &&
      taskResult.data.title === EXPECTED_TASK_TITLE &&
      taskResult.data.status === 'Planning' &&
      typeof taskResult.data.details === 'string' &&
      taskResult.data.details.includes('No customer or financial data attached'),
    'The configured task does not match the dedicated, synthetic staging fixture or is not in Planning.');
    pass('workspace membership and synthetic task access enforced by RLS');

    const finnlpStatus = await postFunction(
      baseUrl,
      anonKey,
      'finnlp-integration',
      { action: 'status', workspaceId: workspaceId },
      accessToken,
    );
    assert(finnlpStatus.response.status === 200 &&
      finnlpStatus.body && typeof finnlpStatus.body.connected === 'boolean',
    'FinNLP connection status request failed (HTTP ' + finnlpStatus.response.status +
      ', code ' + readCode(finnlpStatus.body) + ').');
    pass('FinNLP integration status endpoint authenticates and returns a scoped status (' +
      (finnlpStatus.body.connected ? 'connection present' : 'not connected') + ')');

    const goal = 'Use the text-transform tool (tool ID text-transform, version 1.0.0) with operation uppercase and input text "year over year revenue growth". This is a fictional glossary example, not a factual claim about a real company. Return a single-step plan that transforms the supplied text and briefly explains the term. Do not consult outside sources or initiate a real business action.';
    const plannerResult = await postFunction(
      baseUrl,
      anonKey,
      'plan-workflow',
      { taskId: taskId, goal: goal },
      accessToken,
    );
    const plannerErrorCode = readCode(plannerResult.body);
    const plannerErrorMessage = readSafeMessage(plannerResult.body);
    assert(plannerResult.response.status === 200 && plannerResult.body &&
      plannerResult.body.plan && typeof plannerResult.body.plan.id === 'string',
    plannerErrorCode === 'PROVIDER_QUOTA_EXCEEDED'
      ? 'Planner API reported a credit, usage, or spending limit. Check API billing and usage limits before retrying.'
      : 'Planner request failed (HTTP ' + plannerResult.response.status +
        ', code ' + plannerErrorCode + '). ' +
        (plannerErrorMessage ?? 'No safe provider diagnostic was returned. Check the planner API key, model ID, endpoint, and provider account limits.'));

    const plan = plannerResult.body.plan;
    assert(plan.taskId === taskId && plan.goal === goal &&
      plan.validationStatus === 'valid' &&
      Array.isArray(plan.steps) && plan.steps.length > 0 &&
      plan.steps.some((step) => step && step.toolId === 'text-transform'),
    'Planner response did not produce a valid, task-bound text-transform proposal.');

    const limitations = Array.isArray(plan.limitations) ? plan.limitations : [];
    assert(limitations.some((item) => typeof item === 'string' && item.startsWith('FinNLP review status:')),
      'Planner returned a proposal but did not record the live FinNLP review handoff. Check reviewer provider configuration.');
    assert(limitations.some((item) => typeof item === 'string' &&
      item.includes('No independent source snippets were supplied during planning review')),
    'FinNLP handoff did not preserve the no-independent-evidence caveat.');

    const savedPlanResult = await client.from('workflow_plans')
      .select('id, workspace_id, task_id, version, decision, plan')
      .eq('id', plan.id)
      .eq('workspace_id', workspaceId)
      .eq('task_id', taskId)
      .maybeSingle();
    assert(!savedPlanResult.error && savedPlanResult.data &&
      savedPlanResult.data.decision === 'proposed' &&
      savedPlanResult.data.plan &&
      savedPlanResult.data.plan.validationStatus === 'valid',
    'The plan was not saved as a valid proposal visible to its workspace owner.');
    pass('live planner + one FinNLP review/refinement pass persisted a valid proposed plan');

    // A proposal must not be runnable before a human accepts it.
    const startAttempt = await client.rpc('start_workflow_plan_run', { p_plan_id: plan.id });
    assert(startAttempt.error && startAttempt.error.code === '22023',
      'Execution gate did not reject starting a plan that is still proposed.');
    const runQuery = await client.from('workflow_plan_runs')
      .select('id')
      .eq('plan_id', plan.id);
    assert(!runQuery.error && Array.isArray(runQuery.data) && runQuery.data.length === 0,
      'A workflow run was created for a plan that had not been accepted.');
    pass('proposed plan cannot start a workflow run before human acceptance');

    // This only checks authorization for a missing run. It does not dispatch a worker.
    const missingRun = await postFunction(
      baseUrl,
      anonKey,
      'advance-plan-run',
      { planRunId: UNKNOWN_RUN_ID },
      accessToken,
    );
    assert(missingRun.response.status === 403 && readCode(missingRun.body) === 'PERMISSION_DENIED',
      'Worker endpoint did not deny access to a run that is not authorized for this user.');
    pass('worker endpoint rejects a missing/unowned run without dispatching work');

    const taskAfter = await client.from('tasks')
      .select('status')
      .eq('id', taskId)
      .maybeSingle();
    assert(!taskAfter.error && taskAfter.data && taskAfter.data.status === 'Planning',
      'The test task left Planning status during the non-executing smoke test.');

    const executionsAfter = await client.from('task_tool_executions')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('task_id', taskId);
    assert(!executionsAfter.error && Array.isArray(executionsAfter.data) &&
      executionsAfter.data.length === 0,
    'The smoke test unexpectedly created tool executions; inspect the staging task before rerunning.');
    pass('no tool executed; task remains in Planning and the proposal remains unaccepted');

    process.stdout.write('\nStaging smoke test passed. No plan was accepted and no tool was executed.\n');
    process.stdout.write('Plan ID: ' + plan.id + '\n');
    process.stdout.write('Plan version: ' + String(savedPlanResult.data.version) + '\n');
    process.stdout.write('The run intentionally did not test invoice extraction with a real attachment or positive worker recovery.\n');
  } finally {
    try {
      await client.auth.signOut({ scope: 'local' });
    } catch {
      // Do not let session cleanup conceal the primary test result.
    }
  }
}

try {
  await main();
} catch (error) {
  const safeMessage = error instanceof Error ? error.message : 'Unknown staging smoke failure.';
  process.stderr.write('FAIL ' + safeMessage + '\n');
  process.exitCode = 1;
}
