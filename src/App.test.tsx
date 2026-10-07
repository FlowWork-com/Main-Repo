import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('clearly identifies the example status as a prototype', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'Workflow progress' })).toBeTruthy();
    expect(
      screen.getByText(/status is illustrative and is not connected to a live workflow/i),
    ).toBeTruthy();
    expect(screen.getByText('Planning').parentElement?.getAttribute('aria-current')).toBe('step');
  });
});
