import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SupabaseWorkflowRepository } from '../../../src/backend/workflowRepository.ts';
import { createVerifiedAuthenticator } from '../execute-tool/auth.ts';
import { createServerToolExecutionService } from '../execute-tool/createService.ts';
import {
  createAdvancePlanRunHandler,
  parseAllowedOrigins,
} from './handler.ts';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const supabaseUrl = requiredEnvironment('SUPABASE_URL');
const anonKey = requiredEnvironment('SUPABASE_ANON_KEY');
const serviceRoleKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const handler = createAdvancePlanRunHandler<SupabaseClient>({
  origins: parseAllowedOrigins(Deno.env.get('APP_ORIGINS')),
  // The service-role secret is server-only and is never returned to clients.
  // The function has verify_jwt=false so every request is authenticated here:
  // either a verified user JWT or this exact internal dispatch credential.
  workerSecret: serviceRoleKey,
  authenticate: createVerifiedAuthenticator((accessToken) =>
    createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    })),
  authorizeRun: async (userId, runId) => {
    const { data: run, error: runError } = await serviceClient
      .from('workflow_plan_runs')
      .select('id, workspace_id, status')
      .eq('id', runId)
      .maybeSingle();
    if (runError) throw new Error('Plan run lookup failed.');
    if (!run || run.status !== 'running') return false;
    const { data: membership, error: membershipError } = await serviceClient
      .from('workspace_members')
      .select('workspace_id')
      .eq('workspace_id', run.workspace_id)
      .eq('user_id', userId)
      .maybeSingle();
    if (membershipError) throw new Error('Workspace membership lookup failed.');
    return Boolean(membership);
  },
  scheduleBackground: (task) => EdgeRuntime.waitUntil(task()),
  dispatchWorker: async (runId) => {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/advance-plan-run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-flowwork-worker-key': serviceRoleKey,
      },
      body: JSON.stringify({ planRunId: runId }),
    });
    if (!response.ok) throw new Error('Worker dispatch failed.');
  },
  processRun: async (runId) => {
    const workerId = crypto.randomUUID();
    const { data: claim, error: claimError } = await serviceClient.rpc(
      'claim_workflow_plan_run_worker',
      { p_run_id: runId, p_worker_id: workerId, p_lease_seconds: 120 },
    );
    if (claimError) {
      console.error('[advance-plan-run]', 'WORKER_CLAIM_FAILED');
      return;
    }
    if (!isRecord(claim) || claim.status !== 'running') return;

    let stepId: string | null = null;
    try {
      const { data: run, error: runError } = await serviceClient
        .from('workflow_plan_runs')
        .select('id, workspace_id, task_id, plan_id, plan_version, started_by, status')
        .eq('id', runId)
        .maybeSingle();
      if (runError || !run || run.status !== 'running') {
        await finishWorker(runId, workerId, null, false, 'INVALID_EXECUTION_CONTEXT');
        return;
      }

      const { data: plan, error: planError } = await serviceClient
        .from('workflow_plans')
        .select('version, decision, plan')
        .eq('id', run.plan_id)
        .maybeSingle();
      if (planError || !plan || plan.decision !== 'accepted' || plan.version !== run.plan_version) {
        await finishWorker(runId, workerId, null, false, 'INVALID_EXECUTION_CONTEXT');
        return;
      }

      const { data: rows, error: stepsError } = await serviceClient
        .from('workflow_plan_step_runs')
        .select('step_id, step_index, tool_id, tool_version, input, dependencies, status, attempt')
        .eq('run_id', runId)
        .order('step_index', { ascending: true });
      if (stepsError || !rows?.length || rows.length > 10) {
        await finishWorker(runId, workerId, null, false, 'INVALID_EXECUTION_CONTEXT');
        return;
      }

      const succeeded = new Set(rows.filter((row) => row.status === 'succeeded').map((row) => row.step_id));
      const next = rows.find((row) =>
        row.status === 'pending' &&
        Array.isArray(row.dependencies) &&
        row.dependencies.every((dependency: unknown) => typeof dependency === 'string' && succeeded.has(dependency))
      );

      if (!next) {
        if (rows.every((row) => row.status === 'succeeded')) {
          const result = await finishWorker(runId, workerId, null, true, null);
          if (result === 'running') await dispatchNext(runId);
        } else {
          await finishWorker(runId, workerId, null, false, 'UNKNOWN');
        }
        return;
      }

      stepId = next.step_id;
      const workflowRepository = new SupabaseWorkflowRepository(serviceClient);
      const task = await workflowRepository.getTask(run.task_id);
      if (!task || task.workspaceId !== run.workspace_id || task.workflow.task.status !== 'Running') {
        await finishWorker(runId, workerId, stepId, false, 'INVALID_EXECUTION_CONTEXT');
        return;
      }

      const service = createServerToolExecutionService(serviceClient, workflowRepository);
      const executionId = crypto.randomUUID();
      const outcome = await service.execute({
        userId: run.started_by,
        workspaceId: run.workspace_id,
        taskId: run.task_id,
        planRunId: runId,
        stepId: next.step_id,
        executionId,
        requestId: `plan-run:${runId}:${stepId}:${executionId}`,
        toolId: next.tool_id,
        toolVersion: next.tool_version,
        input: next.input,
      }, task.workflow, AbortSignal.timeout(55_000));

      const finalStatus = await finishWorker(
        runId,
        workerId,
        stepId,
        outcome.result.success,
        outcome.result.success ? null : outcome.result.error.code,
      );
      if (finalStatus === 'running') await dispatchNext(runId);
    } catch {
      try {
        await finishWorker(runId, workerId, stepId, false, 'UNKNOWN');
      } catch {
        console.error('[advance-plan-run]', 'WORKER_FINALIZATION_FAILED');
      }
      console.error('[advance-plan-run]', 'WORKER_STEP_FAILED');
    }
  },
  logFailure: (code) => console.error('[advance-plan-run]', code),
});

Deno.serve(handler);

async function finishWorker(
  runId: string,
  workerId: string,
  stepId: string | null,
  stepSucceeded: boolean,
  errorCode: string | null,
): Promise<string> {
  const { data, error } = await serviceClient.rpc('finish_workflow_plan_run_worker', {
    p_run_id: runId,
    p_worker_id: workerId,
    p_step_id: stepId,
    p_step_succeeded: stepSucceeded,
    p_error_code: errorCode,
  });
  if (error || !isRecord(data) || typeof data.status !== 'string') {
    throw new Error('Unable to finalize plan worker.');
  }
  return data.status;
}

async function dispatchNext(runId: string): Promise<void> {
  const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/advance-plan-run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-flowwork-worker-key': serviceRoleKey,
    },
    body: JSON.stringify({ planRunId: runId }),
  });
  if (!response.ok) throw new Error('Unable to dispatch next plan step.');
}

function requiredEnvironment(name: string): string {
  const value = Deno.env.get(name);
  if (!value?.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
