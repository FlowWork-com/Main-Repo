import { TaskTimeline } from './components/TaskTimeline';

export function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="FlowWork home">
          <span className="brand__mark" aria-hidden="true">
            F
          </span>
          <span>FlowWork</span>
        </a>
        <span className="preview-badge">Frontend preview</span>
      </header>

      <main className="main-content">
        <section className="welcome" aria-labelledby="welcome-title">
          <p className="eyebrow">Your workspace</p>
          <h1 id="welcome-title">Make work move forward.</h1>
          <p className="welcome__description">
            FlowWork brings your business workflows into one clear, reliable
            view.
          </p>
        </section>

        <section className="preview-card" aria-labelledby="preview-title">
          <div className="preview-card__intro">
            <div>
              <p className="eyebrow">UI component preview</p>
              <h2 id="preview-title">A workflow, at a glance</h2>
            </div>
            <span className="preview-badge preview-badge--subtle">Example</span>
          </div>
          <p className="preview-card__note">
            This sample illustrates the progress timeline. Live workflow data
            is not connected in this scaffold.
          </p>
          <TaskTimeline
            currentStep="Waiting for approval"
            stepsHistory={['Planning', 'Running']}
          />
        </section>
      </main>

      <footer className="footer">
        Built for clear, dependable work.
      </footer>
    </div>
  );
}
