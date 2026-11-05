export function getAuthRedirectTo(
  browserOrigin: string,
  configuredRedirect?: string,
): string {
  const candidate = configuredRedirect?.trim();
  if (!candidate) return browserOrigin;

  try {
    const redirect = new URL(candidate);
    const isLoopbackHttp = redirect.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);
    if (
      (redirect.protocol !== 'https:' && !isLoopbackHttp) ||
      redirect.username ||
      redirect.password ||
      redirect.pathname !== '/' ||
      redirect.search ||
      redirect.hash
    ) {
      return browserOrigin;
    }
    return redirect.origin;
  } catch {
    return browserOrigin;
  }
}

export function getCodespacesAuthRedirect(
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
