import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskTimeline } from './TaskTimeline';

describe('TaskTimeline', () => {
  it('renders each operational status and marks only the current step', () => {
    render(<TaskTimeline currentStep="Waiting for approval" />);

    expect(screen.getByRole('heading', { name: 'Operational progress' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByText('Current status')).toBeTruthy();
    expect(screen.getByText('Waiting for approval').parentElement?.getAttribute('aria-current')).toBe(
      'step',
    );
    expect(screen.getByText('Completed').parentElement?.getAttribute('aria-current')).toBe(null);
  });
});
