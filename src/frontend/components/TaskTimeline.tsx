import './TaskTimeline.css';

const STATUS_STEPS = [
  { label: 'Planning', icon: '📋' },
  { label: 'Running', icon: '⚙️' },
  { label: 'Waiting for approval', icon: '⏳' },
  { label: 'Verifying', icon: '🔍' },
  { label: 'Completed', icon: '✅' },
  { label: 'Failed', icon: '❌' },
] as const;

export type TaskStatus = (typeof STATUS_STEPS)[number]['label'];

type TaskTimelineProps = {
  currentStep: TaskStatus;
};

export function TaskTimeline({ currentStep }: TaskTimelineProps) {
  return (
    <section className="task-timeline" aria-labelledby="task-timeline-title">
      <h2 id="task-timeline-title">Operational progress</h2>
      <ol className="task-timeline__steps" aria-live="polite">
        {STATUS_STEPS.map(({ label, icon }) => {
          const isActive = currentStep === label;

          return (
            <li
              className={`task-timeline__step${isActive ? ' task-timeline__step--active' : ''}`}
              key={label}
              aria-current={isActive ? 'step' : undefined}
            >
              <span className="task-timeline__icon" aria-hidden="true">
                {icon}
              </span>
              <span>{label}</span>
              {isActive && <span className="task-timeline__current">Current status</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
