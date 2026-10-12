import { useEffect, useState } from 'react';
import {
  assertPlannerConfigured,
  createPlannerError,
  type WorkflowPlan,
} from '../../planning/planning';

const STORAGE_PREFIX = 'flowwork.plan';

export function PlanReviewPanel({
  taskId,
  taskTitle,
}: {
  readonly taskId: string;
  readonly taskTitle: string;
}) {
  const [goal, setGoal] = useState(taskTitle);
  const [plan, setPlan] = useState<WorkflowPlan | null>(() => loadPlan(taskId));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (plan) {
      window.localStorage.setItem(`${STORAGE_PREFIX}:${taskId}`, JSON.stringify(plan));
    } else {
      window.localStorage.removeItem(`${STORAGE_PREFIX}:${taskId}`);
    }
  }, [plan, taskId]);

  async function requestPlan() {
    setBusy(true);
    setError('');
    try {
      assertPlannerConfigured({ provider: undefined });
      throw createPlannerError('PROVIDER_UNAVAILABLE', 'The planner provider is unavailable.');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Unable to generate a plan.';
      setError(message);
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
      </header>

      <p className="notice">
        A proposed plan is not an executed task and does not authorize an external action.
      </p>

      <label className="form-stack">
        Goal
        <textarea
          maxLength={2000}
          onChange={(event) => setGoal(event.target.value)}
          rows={3}
          value={goal}
        />
      </label>

      <button className="button" disabled={busy || !goal.trim()} onClick={() => void requestPlan()} type="button">
        {busy ? 'Generating proposal…' : 'Request plan'}
      </button>

      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}

      {!plan && !error && (
        <p className="notice">No plan has been proposed yet. Add a goal and request a plan.</p>
      )}

      {plan && (
        <div className="form-stack">
          <h4>{plan.summary}</h4>
          <p>{plan.goal}</p>
          <ol>
            {plan.steps.map((step) => (
              <li key={step.id}>
                <strong>{step.title}</strong>
                <div>Tool: {step.toolId} v{step.toolVersion}</div>
                <div>Dependencies: {step.dependencies.length ? step.dependencies.join(', ') : 'none'}</div>
                <div>Expected outcome: {step.expectedOutcome}</div>
                <div>Verification: {step.verificationCriteria}</div>
              </li>
            ))}
          </ol>
          <div className="task-actions">
            <button className="button" onClick={() => setPlan(null)} type="button">
              Reject plan
            </button>
            <button className="button button--secondary" onClick={() => setPlan({ ...plan, validationStatus: 'valid' })} type="button">
              Accept plan
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function loadPlan(taskId: string): WorkflowPlan | null {
  try {
    const value = window.localStorage.getItem(`${STORAGE_PREFIX}:${taskId}`);
    if (!value) return null;
    const parsed = JSON.parse(value) as WorkflowPlan;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
