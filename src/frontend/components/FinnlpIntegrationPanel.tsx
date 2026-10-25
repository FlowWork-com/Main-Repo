import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';

interface FinnlpConnectionStatus {
  readonly connected: boolean;
  readonly connectedAt: string | null;
}

interface FinnlpIntegrationPanelProps {
  readonly client: SupabaseClient;
  readonly workspaceId: string;
  readonly canAccessWorkspace: boolean;
}

export function FinnlpIntegrationPanel({
  client,
  workspaceId,
  canAccessWorkspace,
}: FinnlpIntegrationPanelProps) {
  const [connection, setConnection] = useState<FinnlpConnectionStatus>({
    connected: false,
    connectedAt: null,
  });
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refreshStatus = useCallback(async () => {
    if (!canAccessWorkspace) {
      setLoading(false);
      return;
    }
    try {
      const { data, error: invokeError } = await client.functions.invoke<unknown>('finnlp-integration', {
        body: { action: 'status', workspaceId },
      });
      if (invokeError || !isRecord(data) || typeof data.connected !== 'boolean') {
        throw new Error('status_unavailable');
      }
      setConnection({
        connected: data.connected,
        connectedAt: typeof data.connectedAt === 'string' ? data.connectedAt : null,
      });
    } catch {
      setError('Unable to check FinNLP connection status. Confirm workspace access and server configuration.');
    } finally {
      setLoading(false);
    }
  }, [canAccessWorkspace, client, workspaceId]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = apiKey.trim();
    if (!canAccessWorkspace || busy || !candidate) return;

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data, error: invokeError } = await client.functions.invoke<unknown>('finnlp-integration', {
        body: { action: 'connect', workspaceId, apiKey: candidate },
      });
      if (invokeError || !isRecord(data) || data.connected !== true) {
        throw new Error('connect_failed');
      }
      setConnection({
        connected: true,
        connectedAt: typeof data.connectedAt === 'string' ? data.connectedAt : null,
      });
      setNotice('FinNLP/Finnhub is connected for read-only company-news retrieval.');
    } catch {
      setError('Unable to connect. Check the Finnhub API key and provider availability, then retry.');
    } finally {
      setApiKey('');
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!canAccessWorkspace || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data, error: invokeError } = await client.functions.invoke<unknown>('finnlp-integration', {
        body: { action: 'disconnect', workspaceId },
      });
      if (invokeError || !isRecord(data) || data.connected !== false) {
        throw new Error('disconnect_failed');
      }
      setConnection({ connected: false, connectedAt: null });
      setNotice('FinNLP/Finnhub was disconnected and its stored credential was removed.');
    } catch {
      setError('Unable to disconnect FinNLP. Retry, then refresh connection status.');
    } finally {
      setApiKey('');
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="finnlp-integration-title">
      <header className="task-detail__heading">
        <div>
          <p className="eyebrow">Read-only data source</p>
          <h3 id="finnlp-integration-title">FinNLP company news</h3>
        </div>
        <span className="status-pill">
          {loading ? 'Checking…' : connection.connected ? 'Connected' : 'Not connected'}
        </span>
      </header>
      <p className="notice">
        Connect a Finnhub API key to retrieve public company-news articles for a ticker and a date range
        of up to 31 days. The key is sent to the server only and stored with Supabase Vault. News is
        untrusted source material, not a trading recommendation.
      </p>
      {!canAccessWorkspace ? (
        <p className="error-message" role="alert">Workspace access is required to manage this integration.</p>
      ) : (
        <>
          {connection.connected && connection.connectedAt && (
            <p className="form-stack">
              Connected {new Date(connection.connectedAt).toLocaleString()}.
            </p>
          )}
          <form className="form-stack" onSubmit={(event) => void connect(event)}>
            <label>
              Finnhub API key
              <input
                autoComplete="off"
                disabled={busy || loading}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={connection.connected ? 'Enter a new key to replace the current key' : 'Paste API key'}
                type="password"
                value={apiKey}
              />
            </label>
            <div className="task-actions">
              <button className="button" disabled={busy || loading || apiKey.trim().length < 16} type="submit">
                {busy ? 'Saving…' : connection.connected ? 'Replace API key' : 'Connect FinNLP'}
              </button>
              {connection.connected && (
                <button className="button button--danger" disabled={busy || loading} onClick={() => void disconnect()} type="button">
                  Disconnect
                </button>
              )}
            </div>
          </form>
        </>
      )}
      {error && <p className="error-message" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
    </section>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
