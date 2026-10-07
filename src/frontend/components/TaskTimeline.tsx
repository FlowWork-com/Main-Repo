import {
  WORKFLOW_STATUSES,
  type WorkflowStatus,
} from '../../workflow/workflow';

interface TaskTimelineProps {
  currentStep: WorkflowStatus;
  stepsHistory?: readonly WorkflowStatus[];
}

export function TaskTimeline({
  currentStep,
  stepsHistory = [],
}: TaskTimelineProps) {
  return (
    <section className="timeline" aria-labelledby="timeline-title">
      <header className="timeline__header">
        <div>
          <p className="eyebrow">Example progress</p>
          <h2 id="timeline-title">Operational progress</h2>
        </div>
        <span className="timeline__current">{currentStep}</span>
      </header>

      <ol className="timeline__steps" aria-label="Workflow status history">
        {WORKFLOW_STATUSES.map((step) => {
          const isCurrent = currentStep === step;
          const wasVisited = stepsHistory.includes(step) && !isCurrent;
          const stateLabel = isCurrent
            ? 'Current'
            : wasVisited
              ? 'Visited'
              : 'Upcoming';

          return (
            <li
              className={`timeline__step${isCurrent ? ' timeline__step--current' : ''}${wasVisited ? ' timeline__step--visited' : ''}${step === 'Failed' ? ' timeline__step--failed' : ''}`}
              key={step}
              aria-label={`${step}, ${stateLabel}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span className="timeline__marker" aria-hidden="true">
                {wasVisited ? '✓' : ''}
              </span>
              <span className="timeline__label">{step}</span>
              <span className="timeline__state">{stateLabel}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
