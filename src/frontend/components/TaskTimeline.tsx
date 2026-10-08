import {
  WORKFLOW_STATUSES,
  type WorkflowAggregate,
  type WorkflowEvent,
} from '../../workflow/workflow';

interface TaskTimelineProps {
  readonly aggregate: WorkflowAggregate;
}

export function TaskTimeline({ aggregate }: TaskTimelineProps) {
  const currentStep = aggregate.task.status;
  const visitedStatuses = new Set(
    aggregate.events.slice(0, -1).map((event) => event.statusAfter),
  );

  return (
    <section className="timeline" aria-labelledby="timeline-title">
      <header className="timeline__header">
        <div>
          <p className="eyebrow">Saved progress</p>
          <h3 id="timeline-title">Operational progress</h3>
        </div>
        <span className="timeline__current">{currentStep}</span>
      </header>

      <ol className="timeline__steps" aria-label="Workflow status history">
        {WORKFLOW_STATUSES.map((step) => {
          const isCurrent = currentStep === step;
          const wasVisited = visitedStatuses.has(step) && !isCurrent;
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

      <h4 className="timeline__history-title">Event history</h4>
      <ol className="event-history" aria-label="Saved workflow events">
        {aggregate.events.map((event) => (
          <li className="event-history__item" key={`${event.sequence}-${event.type}`}>
            <span className="event-history__marker" aria-hidden="true" />
            <div>
              <p className="event-history__label">{describeEvent(event)}</p>
              <time dateTime={event.occurredAt}>
                {new Date(event.occurredAt).toLocaleString()}
              </time>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function describeEvent(event: WorkflowEvent): string {
  switch (event.type) {
    case 'task.created':
      return 'Task created in Planning';
    case 'status.changed':
      return `${event.from} → ${event.to}${event.reason ? ` — ${event.reason}` : ''}`;
    case 'approval.requested':
      return 'Approval requested';
    case 'approval.recorded':
      return `Approval ${event.result.decision}${event.result.reason ? ` — ${event.result.reason}` : ''}`;
    case 'verification.recorded':
      return `Verification ${event.result.passed ? 'passed' : 'failed'} — evidence: ${event.result.evidenceReference}`;
  }
}
