import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { getAuthRedirectTo, getCodespacesAuthRedirect } from './authRedirect';

describe('App configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('clearly requires Supabase URL and public anon key instead of falling back', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

    render(<App />);

    expect(
      screen.getByRole('heading', { name: 'What do you need done?' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Connect Supabase to continue' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send sign-in link' })).not.toBeInTheDocument();
  });
});

describe('email sign-in redirect', () => {
  it('uses the browser origin by default', () => {
    expect(getAuthRedirectTo('https://codespace-5173.app.github.dev')).toBe(
      'https://codespace-5173.app.github.dev',
    );
  });

  it('uses an explicitly configured HTTPS origin for hosted Auth allowlists', () => {
    expect(getAuthRedirectTo(
      'http://localhost:5173',
      'https://flowwork-staging.example.test',
    )).toBe('https://flowwork-staging.example.test');
  });

  it('derives the forwarded port URL in Codespaces when localhost is used locally', () => {
    expect(getCodespacesAuthRedirect('orange-happiness-gxqg6gjwjx4v2wpgq', 'app.github.dev'))
      .toBe('https://orange-happiness-gxqg6gjwjx4v2wpgq-5173.app.github.dev');
    expect(getCodespacesAuthRedirect(undefined, 'app.github.dev')).toBeUndefined();
    expect(getCodespacesAuthRedirect('invalid/name', 'app.github.dev')).toBeUndefined();
  });

  it('rejects unsafe or malformed overrides and falls back to the browser origin', () => {
    const origin = 'https://codespace-5173.app.github.dev';
    expect(getAuthRedirectTo(origin, 'javascript:alert(1)')).toBe(origin);
    expect(getAuthRedirectTo(origin, 'https://user:pass@example.test')).toBe(origin);
    expect(getAuthRedirectTo(origin, 'https://example.test/path')).toBe(origin);
    expect(getAuthRedirectTo(origin, 'not a URL')).toBe(origin);
  });
});
