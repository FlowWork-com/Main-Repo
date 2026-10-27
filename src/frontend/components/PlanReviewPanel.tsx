import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMvpTools } from '../../tools/mvpTools';
import { ToolRegistry } from '../../tools/toolRegistry';
import { PlannerError, validatePlan, type WorkflowPlan } from '../../planning/planning';

interface PersistedPlan {
  readonly id: string;
  readonly version: number;
  readonly decision: 'proposed' | 'accepted' | 'rejected';
  readonly plan: WorkflowPlan;
}

const registry = new ToolRegistry();
for (const tool of createMvpTools({ async getTaskFileMetadata() { return null; } })) {
  registry.register(tool);
}

export function PlanReviewPanel({
  client,
  canAccessWorkspace,
  taskStatus,
  taskId,
  taskTitle,
  onTaskRefresh,
}: {
  readonly client: SupabaseClient;
  readonly canAccessWorkspace: boolean;
  readonly taskStatus: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly onTaskRefresh?: () => Promise<unknown>;
}) {
  const [goal, setGoal] = useState(taskTitle);
  const [proposal, setProposal] = useState<PersistedPlan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [runId, setRunId] = useState('');
  const [runStatus, setRunStatus] = useState<'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | ''>('');
  const [runPauseReason, setRunPauseReason] = useState('');
  const [stepStatuses, setStepStatuses] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    void loadLatestPlan(client, taskId)
      .then((saved) => {
        if (active) setProposal(saved);
      })
      .catch(() => {
        if (active) setError('Unable to load the saved plan. Check your access and retry.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [client, taskId]);

  const proposalId = proposal?.id;
  const proposalDecision = proposal?.decision;

  useEffect(() => {
    if (!proposalId || proposalDecision !== 'accepted') return;
    let active = true;
    void loadLatestRun(client, taskId, proposalId)
      .then((run) => {
        if (!active) return;
        setRunId(run?.id ?? '');
        setRunStatus(run?.status ?? '');
        setRunPauseReason(run?.pauseReason ?? '');
        setStepStatuses(run?.steps ?? {});
      })
      .catch(() => {
        if (active) setError('Unable to load saved plan execution progress.');
      });
    return () => { active = false; };
  }, [client, proposalId, proposalDecision, taskId]);

  useEffect(() => {
    if (!proposalId || proposalDecision !== 'accepted' || runStatus !== 'running') return;
    let active = true;
    const refresh = async () => {
      try {
        const run = await loadLatestRun(client, taskId, proposalId);
        if (!active || !run) return;
        setRunId(run.id);
        setRunStatus(run.status);
        setRunPauseReason(run.pauseReason);
        setStepStatuses(run.steps);
        if (run.status === 'succeeded') await onTaskRefresh?.();
      } catch {
        if (active) setError('Unable to refresh saved execution progress.');
      }
    };
    const timer = setInterval(() => { void refresh(); }, 2_000);
    return () => { active = false; clearInterval(timer); };
  }, [client, proposalId, proposalDecision, runStatus, taskId, onTaskRefresh]);

  async function requestPlan() {
    if (!canAccessWorkspace || !goal.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await withTimeout(
        client.functions.invoke<{ plan: unknown }>('plan-workflow', {
          body: { taskId, goal: goal.trim() },
        }),
        30_000,
      );
      if (result.error || !result.data || !isRecord(result.data) || !('plan' in result.data)) {
        throw await normalizeFunctionError(result.error);
      }
      const returned = validatePlan(result.data.plan, registry, { taskId, goal: goal.trim() });
      const saved = await loadPlanById(client, taskId, returned.id);
      if (!saved || saved.decision !== 'proposed') throw new Error('INVALID_RESPONSE');
      setProposal(saved);
    } catch (caught) {
      setError(plannerMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function startRun() {
    if (!proposal || proposal.decision !== 'accepted' || !canAccessWorkspace || taskStatus !== 'Running' || busy) return;
    setBusy(true);
    setError('');
    try {
      const { data, error: runError } = await client.rpc('start_workflow_plan_run', {
        p_plan_id: proposal.id,
      });
      if (runError || !isRecord(data) || typeof data.id !== 'string' ||
        (data.status !== 'running' && data.status !== 'succeeded')) {
        throw new Error('RUN_START_FAILED');
      }
      setRunId(data.id);
      setRunStatus(data.status);
      const run = await loadLatestRun(client, taskId, proposal.id);
      setStepStatuses(run?.steps ?? Object.fromEntries(proposal.plan.steps.map((step) => [step.id, 'pending'])));
      setRunPauseReason(run?.pauseReason ?? '');
      if (data.status === 'running') {
        const { error: dispatchError } = await client.functions.invoke('advance-plan-run', {
          body: { planRunId: data.id },
        });
        if (dispatchError) setError('The run was saved, but worker dispatch could not be confirmed. Retry worker dispatch from the progress controls.');
      }
    } catch {
      setError('Unable to start this plan run. Confirm the task is Running and the plan is accepted.');
    } finally {
      setBusy(false);
    }
  }

  async function dispatchRun() {
    if (!runId || !canAccessWorkspace || runStatus !== 'running' || busy) return;
    setBusy(true);
    setError('');
    try {
      const { error: dispatchError } = await client.functions.invoke('advance-plan-run', {
        body: { planRunId: runId },
      });
      if (dispatchError) throw new Error('DISPATCH_FAILED');
    } catch {
      setError('Worker dispatch could not be confirmed. The durable run state is unchanged; retry dispatch when ready.');
    } finally {
      setBusy(false);
    }
  }

  async function changeRunState(action: 'pause' | 'resume' | 'cancel') {
    if (!runId || !canAccessWorkspace || busy) return;
    setBusy(true);
    setError('');
    const rpcName = action === 'pause' ? 'pause_workflow_plan_run'
      : action === 'resume' ? 'resume_workflow_plan_run' : 'cancel_workflow_plan_run';
    try {
      const { data, error: stateError } = await client.rpc(rpcName, { p_run_id: runId });
      if (stateError || !isRecord(data) || typeof data.status !== 'string') throw new Error('RUN_STATE_FAILED');
      setRunStatus(data.status as 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled');
      if (action === 'resume') {
        setRunPauseReason('');
        const { error: dispatchError } = await client.functions.invoke('advance-plan-run', {
          body: { planRunId: runId },
        });
        if (dispatchError) throw new Error('DISPATCH_FAILED');
      } else if (action === 'pause') {
        setRunPauseReason('user_paused');
      }
      const run = await loadLatestRun(client, taskId, proposal?.id ?? '');
      if (run) {
        setRunStatus(run.status);
        setRunPauseReason(run.pauseReason);
        setStepStatuses(run.steps);
      }
      await onTaskRefresh?.();
    } catch {
      setError('Unable to update the run. Refresh progress and try again. A running external action may finish before a pause or cancellation takes effect.');
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: 'accepted' | 'rejected') {
    if (!proposal || !canAccessWorkspace || proposal.decision !== 'proposed') return;
    setBusy(true);
    setError('');
    try {
      const { error: decisionError } = await client.rpc('decide_workflow_plan', {
        p_plan_id: proposal.id,
        p_decision: decision,
      });
      if (decisionError) throw new Error('DECISION_FAILED');
      const saved = await loadPlanById(client, taskId, proposal.id);
      if (!saved || saved.id !== proposal.id || saved.decision !== decision) {
        throw new Error('INVALID_RESPONSE');
      }
      setProposal(saved);
    } catch (caught) {
      setError(plannerMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="plan-review-title">
      <header className="task-detail__heading">
        <div>
          <p className="eyebrow">Planning</p>
          <h3 id="plan-review-title">Review proposed plan</h3>
        </div>
        {proposal && <span className="status-pill">Plan v{proposal.version}: {proposal.decision}</span>}
      </header>

      <p className="notice">
        A proposed or accepted plan is not executed work and does not authorize an external action.
      </p>

      {canAccessWorkspace ? (
        <>
          <label className="form-stack">
            Goal
            <textarea
              maxLength={2000}
              onChange={(event) => setGoal(event.target.value)}
              rows={3}
              value={goal}
            />
          </label>
          <button className="button" disabled={busy || !goal.trim() || taskStatus !== 'Planning'} onClick={() => void requestPlan()} type="button">
            {busy ? 'Planning…' : 'Request plan'}
          </button>
        </>
      ) : <p className="error-message" role="alert">Workspace access is required to review plans.</p>}

      {error && <p className="error-message" role="alert">{error}</p>}
      {loading && <p role="status">Loading saved plan…</p>}

      {!loading && !proposal && !error && (
        <p className="notice">No plan has been proposed yet. Add a goal and request a plan.</p>
      )}

      {proposal && (
        <div className="form-stack">
          <h4>{proposal.plan.summary}</h4>
          <p>{proposal.plan.goal}</p>
          {proposal.plan.limitations.length > 0 && (
            <div className="notice">
              <strong>Limitations</strong>
              <ul>{proposal.plan.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
            </div>
          )}
          <ol>
            {proposal.plan.steps.map((step) => (
              <li key={step.id}>
                <strong>{step.title}</strong>
                <p>{step.description}</p>
                <div>Tool: {step.toolId} v{step.toolVersion}</div>
                <div>Dependencies: {step.dependencies.length ? step.dependencies.join(', ') : 'none'}</div>
                <div>Expected outcome: {step.expectedOutcome}</div>
                <div>Verification: {step.verificationCriteria}</div>
              </li>
            ))}
          </ol>
          {proposal.decision === 'accepted' && taskStatus === 'Running' && !runId && (
            <button className="button" disabled={busy} onClick={() => void startRun()} type="button">
              {busy ? 'Starting run…' : 'Start supervised execution'}
            </button>
          )}
          {proposal.decision === 'accepted' && runId && (
            <div className="form-stack" aria-label="Plan execution progress">
              <h4>Execution progress</h4>
              <p>Run status: {runStatus || 'loading'}</p>
              <ol>
                {proposal.plan.steps.map((step) => (
                  <li key={step.id}>
                    <strong>{step.title}</strong> — {stepStatuses[step.id] ?? 'pending'}
                  </li>
                ))}
              </ol>
              {runStatus === 'running' && (
                <div className="task-actions">
                  <button className="button button--secondary" disabled={busy} onClick={() => void dispatchRun()} type="button">
                    {busy ? 'Working…' : 'Retry worker dispatch'}
                  </button>
                  {runPauseReason !== 'user_pause_requested' && runPauseReason !== 'user_cancel_requested' && (
                    <>
                      <button className="button button--secondary" disabled={busy} onClick={() => void changeRunState('pause')} type="button">
                        Pause run
                      </button>
                      <button className="button button--danger" disabled={busy} onClick={() => void changeRunState('cancel')} type="button">
                        Cancel run
                      </button>
                    </>
                  )}
                </div>
              )}
              {runStatus === 'running' && runPauseReason === 'user_pause_requested' && (
                <p className="notice">Pause requested. The current step will finish, then the worker will stop before starting another step.</p>
              )}
              {runStatus === 'running' && runPauseReason === 'user_cancel_requested' && (
                <p className="notice">Cancellation requested. The current step may finish, but no later step will be scheduled.</p>
              )}
              {runStatus === 'paused' && runPauseReason === 'user_paused' && (
                <button className="button" disabled={busy} onClick={() => void changeRunState('resume')} type="button">
                  Resume run
                </button>
              )}
              {runStatus === 'paused' && runPauseReason !== 'user_paused' && (
                <p className="notice">This run is paused for review. FlowWork will not automatically replay a failed or ambiguous step. Review the task execution history before deciding how to proceed.</p>
              )}
              <p className="notice">The worker advances one validated step per bounded invocation. Progress is persisted server-side, and a completed run moves the workflow to verification, not directly to Completed. A currently running external action may finish before pause or cancellation takes effect.</p>
            </div>
          )}
          {proposal.decision === 'proposed' && taskStatus === 'Planning' && (
            <div className="task-actions">
              <button className="button button--danger" disabled={busy} onClick={() => void decide('rejected')} type="button">
                Reject plan
              </button>
              <button
                className="button button--secondary"
                disabled={busy || proposal.plan.validationStatus !== 'valid'}
                onClick={() => void decide('accepted')}
                type="button"
              >
                Accept plan
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

async function loadLatestRun(
  client: SupabaseClient,
  taskId: string,
  planId: string,
): Promise<{ readonly id: string; readonly status: 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'; readonly pauseReason: string; readonly steps: Record<string, string> } | null> {
  const { data: run, error } = await client
    .from('workflow_plan_runs')
    .select('id, status, pause_reason')
    .eq('task_id', taskId)
    .eq('plan_id', planId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!isRecord(run) || typeof run.id !== 'string' || !['running', 'paused', 'succeeded', 'failed', 'cancelled'].includes(String(run.status))) {
    return null;
  }
  const { data: rows, error: stepsError } = await client
    .from('workflow_plan_step_runs')
    .select('step_id, status')
    .eq('run_id', run.id)
    .order('step_index', { ascending: true });
  if (stepsError) throw stepsError;
  const steps: Record<string, string> = {};
  for (const row of rows ?? []) {
    if (isRecord(row) && typeof row.step_id === 'string' && typeof row.status === 'string') {
      steps[row.step_id] = row.status;
    }
  }
  return { id: run.id, status: run.status as 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled', pauseReason: typeof run.pause_reason === 'string' ? run.pause_reason : '', steps };
}

async function loadLatestPlan(client: SupabaseClient, taskId: string): Promise<PersistedPlan | null> {
  const { data, error } = await client
    .from('workflow_plans')
    .select('id, version, decision, plan')
    .eq('task_id', taskId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return validatePersistedRecord(data, taskId);
}

function validatePersistedRecord(data: unknown, taskId: string): PersistedPlan {
  const row = data as PersistedPlan;
  if (!row.id || !Number.isInteger(row.version) || !['proposed', 'accepted', 'rejected'].includes(row.decision)) {
    throw new Error('Invalid persisted plan record.');
  }
  const plan = validatePlan(row.plan, registry, { taskId });
  if (plan.taskId !== taskId || plan.version !== row.version) throw new Error('Invalid persisted plan record.');
  return { ...row, plan };
}

async function loadPlanById(
  client: SupabaseClient,
  taskId: string,
  planId: string,
): Promise<PersistedPlan | null> {
  const { data, error } = await client
    .from('workflow_plans')
    .select('id, version, decision, plan')
    .eq('task_id', taskId)
    .eq('id', planId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return validatePersistedRecord(data, taskId);
}

async function normalizeFunctionError(error: unknown): Promise<Error> {
  if (isRecord(error) && error.context instanceof Response) {
    try {
      const body: unknown = await error.context.clone().json();
      if (isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string') {
        return new Error(body.error.code);
      }
    } catch {
      return new Error('PROVIDER_UNAVAILABLE');
    }
  }
  return new Error('PROVIDER_UNAVAILABLE');
}

function plannerMessage(error: unknown): string {
  const code = error instanceof PlannerError
    ? error.code
    : error instanceof Error ? error.message : '';
  switch (code) {
    case 'PLANNER_NOT_CONFIGURED': return 'Plan generation is not configured for this workspace.';
    case 'PROVIDER_TIMEOUT':
    case 'REQUEST_TIMEOUT': return 'Plan generation timed out. You can retry.';
    case 'PROVIDER_QUOTA_EXCEEDED': return 'The planner API has reached a credit, usage, or spending limit. Check provider billing and limits before retrying.';
    case 'RATE_LIMITED': return 'The planning service is busy. Wait briefly and retry.';
    case 'INVALID_RESPONSE':
    case 'INVALID_PLAN': return 'The planning service returned a plan that could not be validated.';
    case 'UNSUPPORTED_CAPABILITY': return 'This goal requires capabilities that are not available.';
    case 'DECISION_FAILED': return 'Unable to save the plan decision. Reload and retry.';
    default: return 'Plan generation is temporarily unavailable. Please retry.';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('REQUEST_TIMEOUT')), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}