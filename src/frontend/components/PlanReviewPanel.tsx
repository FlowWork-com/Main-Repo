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
}: {
  readonly client: SupabaseClient;
  readonly canAccessWorkspace: boolean;
  readonly taskStatus: string;
  readonly taskId: string;
  readonly taskTitle: string;
}) {
  const [goal, setGoal] = useState(taskTitle);
  const [proposal, setProposal] = useState<PersistedPlan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

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