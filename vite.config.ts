import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import process from 'node:process';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const codespacesRedirect = codespacesAuthRedirect(
    env.CODESPACE_NAME ?? process.env.CODESPACE_NAME,
    env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ?? process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN,
  );
  const authRedirect = env.VITE_AUTH_REDIRECT_URL?.trim() || codespacesRedirect || '';

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_AUTH_REDIRECT_URL': JSON.stringify(authRedirect),
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/frontend/test/setup.ts'],
      restoreMocks: true,
    },
  };
});

function codespacesAuthRedirect(
  codespaceName?: string,
  forwardingDomain?: string,
): string | undefined {
  if (
    !codespaceName ||
    !/^[a-z0-9-]+$/i.test(codespaceName) ||
    !forwardingDomain ||
    !/^[a-z0-9.-]+$/i.test(forwardingDomain)
  ) {
    return undefined;
  }
  return `https://${codespaceName}-5173.${forwardingDomain}`;
}
