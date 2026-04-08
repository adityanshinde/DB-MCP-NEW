'use client';

import { useEffect, useState } from 'react';

type ApiResponse = {
  success: boolean;
  error?: string;
  token?: string;
  expiresInSeconds?: number;
  hasDatabaseCredentials?: boolean;
  hasGitHubCredentials?: boolean;
  databaseType?: string | null;
  githubOrgName?: string | null;
  allowedRepositories?: number;
  allowedOrganizations?: number;
};

const TOKEN_KEY = 'db-mcp-byoc-token';
const DB_KEY = 'db-mcp-byoc-db';
const GITHUB_KEY = 'db-mcp-byoc-github';

const DEFAULT_DB = JSON.stringify(
  {
    type: 'postgres',
    postgres: {
      host: 'localhost',
      port: 5432,
      username: 'postgres',
      password: '',
      database: 'postgres'
    }
  },
  null,
  2
);

const DEFAULT_GITHUB = JSON.stringify(
  {
    pat: 'ghp_your_token_here',
    orgName: 'your-org',
    allowedOrgs: ['your-org'],
    allowedRepos: ['your-org/your-repo']
  },
  null,
  2
);

function readStoredValue(key: string, fallback: string): string {
  if (typeof window === 'undefined') {
    return fallback;
  }

  return window.localStorage.getItem(key) || fallback;
}

export default function ByocConsole() {
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [databaseJson, setDatabaseJson] = useState(DEFAULT_DB);
  const [githubJson, setGithubJson] = useState(DEFAULT_GITHUB);
  const [status, setStatus] = useState<string>('');
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    setToken(readStoredValue(TOKEN_KEY, ''));
    setDatabaseJson(readStoredValue(DB_KEY, DEFAULT_DB));
    setGithubJson(readStoredValue(GITHUB_KEY, DEFAULT_GITHUB));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (token) {
      window.localStorage.setItem(TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(TOKEN_KEY);
    }
  }, [token]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(DB_KEY, databaseJson);
  }, [databaseJson]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(GITHUB_KEY, githubJson);
  }, [githubJson]);

  async function login() {
    setIsBusy(true);
    setStatus('');

    try {
      const response = await fetch('/api/byoc/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password })
      });

      const payload = (await response.json()) as ApiResponse;
      if (!response.ok || !payload.success || !payload.token) {
        throw new Error(payload.error || 'Login failed.');
      }

      setToken(payload.token);
      setStatus(`Token issued. It stays valid for ${Math.floor((payload.expiresInSeconds || 0) / 3600)} hours.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      setIsBusy(false);
    }
  }

  async function saveCredentials(scope: 'database' | 'github') {
    setIsBusy(true);
    setStatus('');

    try {
      const parsedCredentials = scope === 'database' ? JSON.parse(databaseJson) : JSON.parse(githubJson);
      const response = await fetch('/api/byoc/credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          credentials: scope === 'database' ? { db: parsedCredentials } : { github: parsedCredentials }
        })
      });

      const payload = (await response.json()) as ApiResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Failed to save credentials.');
      }

      setStatus(scope === 'database' ? 'Database credentials saved.' : 'GitHub credentials saved.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to save credentials.');
    } finally {
      setIsBusy(false);
    }
  }

  async function clearSession() {
    setIsBusy(true);
    setStatus('');

    try {
      const response = await fetch('/api/byoc/credentials', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ token })
      });

      const payload = (await response.json()) as ApiResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Failed to clear session.');
      }

      setToken('');
      setPassword('');
      setStatus('Session cleared.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to clear session.');
    } finally {
      setIsBusy(false);
    }
  }

  async function copyToken() {
    if (!token) {
      return;
    }

    await navigator.clipboard.writeText(token);
    setStatus('Token copied to clipboard.');
  }

  return (
    <main className="byoc-shell">
      <section className="byoc-grid">
        <div className="byoc-hero">
          <p className="eyebrow">BYOC access</p>
          <h1>Bring your own database and GitHub credentials.</h1>
          <p className="lede">
            Use the shared app password to mint a session token, store encrypted credentials, and send that token as a bearer header from your MCP client.
          </p>

          <div className="feature-grid">
            <div className="feature">App password gates access to the credential vault.</div>
            <div className="feature">Credentials are encrypted before they are persisted.</div>
            <div className="feature">One token can power database tools, GitHub tools, or both.</div>
            <div className="feature">Send `Authorization: Bearer &lt;token&gt;` to `/api/mcp`.</div>
          </div>

          <div className="footer-row">
            <span>MCP endpoint: <strong>/api/mcp</strong></span>
            <span>Token header: <strong>Authorization</strong></span>
          </div>
        </div>

        <aside className="byoc-panel">
          <div className="panel-section">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Step 1</p>
                <h2>Login</h2>
              </div>
              <button className="ghost-button" type="button" onClick={clearSession} disabled={isBusy || !token}>
                Clear session
              </button>
            </div>

            <label className="field">
              <span>App password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Shared deployment password"
                className="input"
              />
            </label>

            <button className="primary-button" type="button" onClick={login} disabled={isBusy || !password.trim()}>
              Create token
            </button>
          </div>

          <div className="panel-section">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Step 2</p>
                <h2>Token</h2>
              </div>
              <button className="ghost-button" type="button" onClick={copyToken} disabled={!token}>
                Copy token
              </button>
            </div>

            <label className="field">
              <span>Bearer token</span>
              <textarea className="textarea token-box" readOnly value={token || 'Login to mint a token.'} />
            </label>
          </div>

          <div className="panel-section">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Step 3</p>
                <h2>Database credentials</h2>
              </div>
              <button className="primary-button" type="button" onClick={() => saveCredentials('database')} disabled={isBusy || !token}>
                Save database
              </button>
            </div>

            <label className="field">
              <span>Database JSON</span>
              <textarea
                className="textarea"
                value={databaseJson}
                onChange={(event) => setDatabaseJson(event.target.value)}
                spellCheck={false}
              />
            </label>
          </div>

          <div className="panel-section">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Step 4</p>
                <h2>GitHub credentials</h2>
              </div>
              <button className="primary-button" type="button" onClick={() => saveCredentials('github')} disabled={isBusy || !token}>
                Save GitHub
              </button>
            </div>

            <label className="field">
              <span>GitHub JSON</span>
              <textarea
                className="textarea"
                value={githubJson}
                onChange={(event) => setGithubJson(event.target.value)}
                spellCheck={false}
              />
            </label>
          </div>

          <div className="panel-footer">
            <p>{status || 'The token can be reused from any MCP client that lets you set custom headers.'}</p>
          </div>
        </aside>
      </section>
    </main>
  );
}