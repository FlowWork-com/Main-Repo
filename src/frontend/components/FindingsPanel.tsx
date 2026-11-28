import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SupabaseToolExecutionHistoryRepository,
  type ToolExecutionHistoryEntry,
} from '../../backend/toolExecutionRepository';
import type { JsonValue } from '../../tools/contracts';
import { createMvpTools } from '../../tools/mvpTools';
import { ToolRegistry } from '../../tools/toolRegistry';
import { validatePlan, type WorkflowPlan } from '../../planning/planning';

interface FindingsTask {
  readonly id: string;
  readonly title: string;
}

interface PersistedPlan {
  readonly id: string;
  readonly version: number;
  readonly decision: 'proposed' | 'accepted' | 'rejected';
  readonly plan: WorkflowPlan;
}

interface PlanStepOutcome {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly title: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly status: string;
  readonly output: unknown;
  readonly error: unknown;
  readonly attempt: number;
  readonly completedAt: string | null;
}

interface PlanRunOutcome {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly steps: readonly PlanStepOutcome[];
}

const registry = new ToolRegistry();
for (const tool of createMvpTools({ async getTaskFileMetadata() { return null; } })) {
  registry.register(tool);
}

export function FindingsPanel({
  client,
  workspaceId,
  tasks,
  selectedTaskId,
  onTaskChange,
}: {
  readonly client: SupabaseClient;
  readonly workspaceId: string;
  readonly tasks: readonly FindingsTask[];
  readonly selectedTaskId: string | null;
  readonly onTaskChange: (taskId: string) => void;
}) {
  const historyRepository = useMemo(
    () => new SupabaseToolExecutionHistoryRepository(client),
    [client],
  );
  const [plan, setPlan] = useState<PersistedPlan | null>(null);
  const [executions, setExecutions] = useState<ToolExecutionHistoryEntry[]>([]);
  const [planRun, setPlanRun] = useState<PlanRunOutcome | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;

  useEffect(() => {
    let active = true;
    async function loadFindings() {
      if (!selectedTaskId) {
        setPlan(null);
        setExecutions([]);
        setPlanRun(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError('');
      try {
        const [savedPlan, savedExecutions, savedRun] = await Promise.all([
          loadLatestPlan(client, selectedTaskId),
          historyRepository.listTaskExecutions(workspaceId, selectedTaskId),
          loadLatestPlanRun(client, workspaceId, selectedTaskId),
        ]);
        if (!active) return;
        setPlan(savedPlan);
        setExecutions(savedExecutions);
        setPlanRun(savedRun);
      } catch {
        if (active) {
          setError('Unable to load saved findings for this workflow. Check workspace access and retry.');
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadFindings();
    return () => { active = false; };
  }, [client, historyRepository, selectedTaskId, workspaceId]);

  const finnlpNotes = useMemo(
    () => (plan?.plan.limitations ?? []).filter(isFinnlpReviewNote),
    [plan],
  );
  const financialExecutions = executions.filter((entry) =>
    entry.toolId === 'financial-arithmetic' || entry.toolId === 'finnlp-financial-review');
  const otherExecutions = executions.filter((entry) =>
    entry.toolId !== 'financial-arithmetic' && entry.toolId !== 'finnlp-financial-review');

  return (
    <section className="findings-view" aria-labelledby="findings-title">
      <header className="workspace__heading">
        <div>
          <p className="eyebrow">Workflow results</p>
          <h2 id="findings-title">Findings</h2>
        </div>
        <label className="findings-view__task-select">
          <span>Workflow</span>
          <select
            aria-label="Choose workflow for findings"
            disabled={tasks.length === 0}
            onChange={(event) => onTaskChange(event.target.value)}
            value={selectedTaskId ?? ''}
          >
            {tasks.length === 0 ? (
              <option value="">No saved workflows</option>
            ) : tasks.map((task) => (
              <option key={task.id} value={task.id}>{task.title}</option>
            ))}
          </select>
        </label>
      </header>

      <p className="workspace-note">
        Review FinNLP's saved handoff, planned expectations, and actual tool outcomes for a workflow.
        Findings are advisory; source authenticity and final acceptance remain subject to human review.
      </p>

      {error && <p className="error-message" role="alert">{error}</p>}
      {loading && <section className="panel" role="status">Loading saved findings…</section>}

      {!loading && !selectedTask && (
        <section className="panel empty-state">
          <h3>No workflow selected</h3>
          <p>Create a workflow in Workspace to see its saved review notes and execution outcomes here.</p>
        </section>
      )}

      {!loading && selectedTask && (
        <>
          <section className="panel findings-card" aria-labelledby="findings-workflow-heading">
            <header className="findings-card__heading">
              <div>
                <p className="eyebrow">Selected workflow</p>
                <h3 id="findings-workflow-heading">{selectedTask.title}</h3>
              </div>
              {plan && <span className="status-pill">Plan v{plan.version}: {plan.decision}</span>}
            </header>
            <p className="findings-card__meta">
              {plan ? 'Latest saved plan and review notes' : 'No saved plan is available for this workflow yet'}
            </p>
          </section>

          <section className="panel findings-card" aria-labelledby="finnlp-findings-heading">
            <header className="findings-card__heading">
              <div>
                <p className="eyebrow">Background specialist review</p>
                <h3 id="finnlp-findings-heading">FinNLP result</h3>
              </div>
              <span className="status-pill">Advisory · human review required</span>
            </header>
            <p className="findings-card__explain">
              This is the planning-time FinNLP handoff saved with the plan. FlowWork stores the bounded
              review notes and questions here; it does not save private model reasoning or a separate raw provider transcript.
            </p>
            {finnlpNotes.length === 0 ? (
              <div className="findings-empty">
                <strong>No FinNLP handoff was found in the saved plan.</strong>
                <p>Generate or refresh the workflow plan after the FinNLP sidecar is configured to create a new review record.</p>
              </div>
            ) : (
              <div className="findings-note-list">
                {finnlpNotes.map((note) => (
                  <article className="findings-note" key={note}>
                    <strong>{finnlpNoteLabel(note)}</strong>
                    <p>{stripFinnlpPrefix(note)}</p>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel findings-card" aria-labelledby="planned-outcomes-heading">
            <header className="findings-card__heading">
              <div>
                <p className="eyebrow">Planner output</p>
                <h3 id="planned-outcomes-heading">Planned steps and expected outcomes</h3>
              </div>
            </header>
            {!plan ? (
              <p className="findings-empty">No plan has been saved for this workflow.</p>
            ) : plan.plan.steps.length === 0 ? (
              <p className="findings-empty">The saved plan contains no executable steps.</p>
            ) : (
              <ol className="findings-step-list">
                {plan.plan.steps.map((step) => (
                  <li key={step.id}>
                    <div className="findings-step-list__heading">
                      <strong>{step.title}</strong>
                      <span>{step.toolId} · v{step.toolVersion}</span>
                    </div>
                    <p>{step.description}</p>
                    <dl>
                      <div>
                        <dt>Expected outcome</dt>
                        <dd>{step.expectedOutcome}</dd>
                      </div>
                      <div>
                        <dt>Verification criteria</dt>
                        <dd>{step.verificationCriteria}</dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ol>
            )}
            {plan && plan.plan.limitations.length > 0 && (
              <details className="findings-details">
                <summary>Other saved limitations and caveats ({plan.plan.limitations.length})</summary>
                <ul>
                  {plan.plan.limitations.map((limitation) => (
                    <li key={limitation}>{limitation}</li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="panel findings-card" aria-labelledby="actual-outcomes-heading">
            <header className="findings-card__heading">
              <div>
                <p className="eyebrow">Persisted execution data</p>
                <h3 id="actual-outcomes-heading">Actual outcomes</h3>
              </div>
            </header>

            {planRun && (
              <div className="findings-run">
                <div className="findings-step-list__heading">
                  <strong>Supervised plan run</strong>
                  <span className={`tool-execution-history__status tool-execution-history__status--${planRun.status}`}>{planRun.status}</span>
                </div>
                <p className="findings-card__meta">
                  Started {new Date(planRun.createdAt).toLocaleString()}
                  {planRun.completedAt ? ` · Finished ${new Date(planRun.completedAt).toLocaleString()}` : ''}
                </p>
                {planRun.steps.length > 0 && (
                  <ol className="findings-step-list">
                    {planRun.steps.map((step) => (
                      <li key={step.stepId}>
                        <div className="findings-step-list__heading">
                          <strong>{step.title}</strong>
                          <span>{step.status} · {step.toolId} v{step.toolVersion}</span>
                        </div>
                        {step.status === 'succeeded' && step.output !== null && (
                          <details className="findings-details">
                            <summary>View saved step output</summary>
                            <pre>{formatJson(step.output)}</pre>
                          </details>
                        )}
                        {step.error !== null && (
                          <pre className="findings-error-output">{formatJson(step.error)}</pre>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            )}

            {executions.length === 0 ? (
              <p className="findings-empty">No manual tool executions have been saved for this workflow.</p>
            ) : (
              <>
                {financialExecutions.length > 0 && (
                  <div className="findings-execution-group">
                    <h4>Financial review and arithmetic</h4>
                    {financialExecutions.map((entry) => (
                      <ToolOutcome key={entry.executionId} entry={entry} />
                    ))}
                  </div>
                )}
                {otherExecutions.length > 0 && (
                  <details className="findings-details">
                    <summary>Other tool executions ({otherExecutions.length})</summary>
                    <div className="findings-execution-group">
                      {otherExecutions.map((entry) => (
                        <ToolOutcome key={entry.executionId} entry={entry} />
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
          </section>

          <p className="findings-disclaimer">
            Calculator outputs verify arithmetic only. They do not authenticate source documents, establish
            that supplied figures are true, or authorize financial actions.
          </p>
        </>
      )}
    </section>
  );
}

function ToolOutcome({ entry }: { readonly entry: ToolExecutionHistoryEntry }) {
  const output = entry.output;
  const arithmetic = entry.toolId === 'financial-arithmetic' ? financialArithmeticSummary(output) : null;
  return (
    <article className="findings-outcome">
      <header className="findings-step-list__heading">
        <strong>{toolDisplayName(entry.toolId)} · v{entry.toolVersion}</strong>
        <span className={`tool-execution-history__status tool-execution-history__status--${entry.status}`}>{entry.status}</span>
      </header>
      <p className="findings-card__meta">
        Executed {new Date(entry.createdAt).toLocaleString()}
        {entry.completedAt ? ` · Finished ${new Date(entry.completedAt).toLocaleString()}` : ''}
      </p>
      {arithmetic && (
        <div className="findings-arithmetic">
          <strong>{arithmetic.label}: {arithmetic.status}</strong>
          <dl>
            {arithmetic.rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {entry.status === 'succeeded' && output !== null && (
        <details className="findings-details">
          <summary>View input and full saved output</summary>
          <pre>{formatJson(entry.input)}</pre>
          <pre>{formatJson(output)}</pre>
        </details>
      )}
      {entry.status === 'failed' && entry.error && (
        <p className="findings-error-output">{entry.error.message}</p>
      )}
      {entry.status === 'running' && (
        <p className="findings-card__meta">The execution is still marked as running; no final outcome is saved.</p>
      )}
    </article>
  );
}

function financialArithmeticSummary(value: JsonValue | null): {
  readonly label: string;
  readonly status: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
} | null {
  if (!isRecord(value) || typeof value.label !== 'string' || typeof value.status !== 'string') return null;
  const rows: { label: string; value: string }[] = [];
  if (typeof value.reportingPeriod === 'string') rows.push({ label: 'Reporting period', value: value.reportingPeriod });
  for (const [key, label] of [
    ['calculatedAmount', 'Calculated amount'],
    ['reportedAmount', 'Reported amount'],
    ['difference', 'Difference'],
  ] as const) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) {
      rows.push({ label, value: formatMoney(value[key] as number, value.currency) });
    }
  }
  if (typeof value.differenceDirection === 'string') {
    rows.push({ label: 'Difference direction', value: value.differenceDirection });
  }
  if (typeof value.sourceVerification === 'string') {
    rows.push({ label: 'Source verification', value: value.sourceVerification });
  }
  if (typeof value.requiresHumanReview === 'boolean') {
    rows.push({ label: 'Human review required', value: value.requiresHumanReview ? 'Yes' : 'No' });
  }
  return { label: value.label, status: value.status, rows };
}

function formatMoney(amount: number, currency: unknown): string {
  const code = typeof currency === 'string' ? currency : '';
  const prefix = code === 'INR' ? '₹' : code === 'USD' ? '$' : code === 'EUR' ? '€' : code ? `${code} ` : '';
  return `${prefix}${amount.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function isFinnlpReviewNote(note: string): boolean {
  return /^FinNLP review status:|^FinNLP decoded meaning:|^FinNLP deterministic arithmetic:|^FinNLP evidence assessment:|^FinNLP clarification:|^FinNLP next step:|^No independent source snippets|^Multiple reporting periods detected|has a reported gross-profit figure but is missing/i.test(note);
}

function finnlpNoteLabel(note: string): string {
  if (note.startsWith('FinNLP review status:')) return 'Review status';
  if (note.startsWith('FinNLP decoded meaning:')) return 'Decoded meaning';
  if (note.startsWith('FinNLP deterministic arithmetic:')) return 'Deterministic arithmetic';
  if (note.startsWith('FinNLP evidence assessment:')) return 'Evidence assessment';
  if (note.startsWith('FinNLP clarification:')) return 'Clarification requested';
  if (note.startsWith('FinNLP next step:')) return 'Recommended next step';
  if (note.startsWith('No independent source snippets')) return 'Evidence limitation';
  return 'Reporting-period finding';
}

function stripFinnlpPrefix(note: string): string {
  return note.replace(/^FinNLP [^:]+:\s*/, '').trim();
}

function toolDisplayName(toolId: string): string {
  return ({
    'financial-arithmetic': 'Financial arithmetic',
    'finnlp-financial-review': 'FinNLP financial review',
  } as Record<string, string>)[toolId] ?? toolId;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return 'Saved result is unavailable.';
  }
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
  if (!data || !isRecord(data)) return null;
  if (typeof data.id !== 'string' || !Number.isInteger(data.version) ||
    (data.decision !== 'proposed' && data.decision !== 'accepted' && data.decision !== 'rejected')) {
    throw new Error('The saved plan record is invalid.');
  }
  const plan = validatePlan(data.plan, registry, { taskId });
  return {
    id: data.id,
    version: data.version as number,
    decision: data.decision,
    plan,
  };
}

async function loadLatestPlanRun(
  client: SupabaseClient,
  workspaceId: string,
  taskId: string,
): Promise<PlanRunOutcome | null> {
  const { data: run, error } = await client
    .from('workflow_plan_runs')
    .select('id, status, created_at, completed_at')
    .eq('workspace_id', workspaceId)
    .eq('task_id', taskId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!isRecord(run) || typeof run.id !== 'string' || typeof run.status !== 'string' ||
    typeof run.created_at !== 'string') return null;

  const { data: rows, error: stepsError } = await client
    .from('workflow_plan_step_runs')
    .select('step_id, step_index, title, tool_id, tool_version, status, output, error, attempt, completed_at')
    .eq('workspace_id', workspaceId)
    .eq('task_id', taskId)
    .eq('run_id', run.id)
    .order('step_index', { ascending: true });
  if (stepsError) throw stepsError;
  const steps: PlanStepOutcome[] = (rows ?? []).flatMap((row: unknown) => {
    if (!isRecord(row) || typeof row.step_id !== 'string' || typeof row.step_index !== 'number' ||
      typeof row.title !== 'string' || typeof row.tool_id !== 'string' ||
      typeof row.tool_version !== 'string' || typeof row.status !== 'string') return [];
    return [{
      stepId: row.step_id,
      stepIndex: row.step_index,
      title: row.title,
      toolId: row.tool_id,
      toolVersion: row.tool_version,
      status: row.status,
      output: row.output ?? null,
      error: row.error ?? null,
      attempt: typeof row.attempt === 'number' ? row.attempt : 0,
      completedAt: typeof row.completed_at === 'string' ? row.completed_at : null,
    }];
  });
  return {
    id: run.id,
    status: run.status,
    createdAt: run.created_at,
    completedAt: typeof run.completed_at === 'string' ? run.completed_at : null,
    steps,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
