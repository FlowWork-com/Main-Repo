import type { AuthenticatedCaller } from './handler.ts';

interface VerifiedUser {
  readonly id: string;
}

interface AuthVerificationClient {
  readonly auth: {
    getUser(
      accessToken: string,
    ): Promise<{
      readonly data: { readonly user: VerifiedUser | null };
      readonly error: unknown | null;
    }>;
  };
}

export function createVerifiedAuthenticator<Client extends AuthVerificationClient>(
  createUserClient: (accessToken: string) => Client,
): (accessToken: string) => Promise<AuthenticatedCaller<Client> | null> {
  return async (accessToken) => {
    const userClient = createUserClient(accessToken);
    const { data, error } = await userClient.auth.getUser(accessToken);
    if (error) {
      if (isAuthenticationRejection(error)) return null;
      throw new Error('Unable to verify the authentication token.');
    }
    if (!data.user) return null;
    return {
      userId: data.user.id,
      context: userClient,
    };
  };
}

function isAuthenticationRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  return error.status === 400 || error.status === 401 || error.status === 403;
}
