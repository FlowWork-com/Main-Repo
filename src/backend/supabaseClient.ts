import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export class SupabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseConfigurationError';
  }
}

let client: SupabaseClient | undefined;

export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = import.meta.env.VITE_SUPABASE_URL?.trim();
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    throw new SupabaseConfigurationError(
      'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to connect FlowWork to Supabase.',
    );
  }

  client = createClient(url, anonKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
    },
  });
  return client;
}
