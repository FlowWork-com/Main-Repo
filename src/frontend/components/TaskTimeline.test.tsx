import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskTimeline } from './TaskTimeline';

describe('TaskTimeline', () => {
  it('identifies the current status and visited history', () => {
    render(
      <TaskTimeline
        currentStep="Waiting for approval"
        stepsHistory={['Planning', 'Running']}
      />,
    );

    const currentStep = screen.getByRole('listitem', { current: 'step' });
    const visitedStep = screen.getByRole('listitem', {
      name: 'Planning, Visited',
    });
    const upcomingStep = screen.getByRole('listitem', {
      name: 'Verifying, Upcoming',
    });

    expect(currentStep).toHaveAttribute('aria-current', 'step');
    expect(currentStep).toHaveTextContent('Waiting for approval');
    expect(within(visitedStep).getByText('Visited')).toBeInTheDocument();
    expect(within(upcomingStep).getByText('Upcoming')).toBeInTheDocument();
  });

  it('supports a failed terminal state without marking unrelated steps visited', () => {
    render(<TaskTimeline currentStep="Failed" stepsHistory={['Planning']} />);

    expect(
      screen.getByRole('listitem', { current: 'step' }),
    ).toHaveTextContent('Failed');
    expect(
      screen.getByRole('listitem', { name: 'Completed, Upcoming' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('listitem', { name: 'Planning, Visited' }),
    ).toBeInTheDocument();
  });
});
