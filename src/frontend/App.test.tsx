import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

describe('App configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('clearly requires Supabase URL and public anon key instead of falling back', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

    render(<App />);

    expect(
      screen.getByRole('heading', { name: 'Connect Supabase to continue' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send sign-in link' })).not.toBeInTheDocument();
  });
});
