import { TaskTimeline } from './frontend/components/TaskTimeline';

export function App() {
  return (
    <main className="app">
      <header className="app__header">
        <p className="app__eyebrow">FlowWork</p>
        <h1>Workflow progress</h1>
        <p className="app__notice">
          UI prototype. The displayed status is illustrative and is not connected to a live workflow.
        </p>
      </header>
      <TaskTimeline currentStep="Planning" />
    </main>
  );
}
