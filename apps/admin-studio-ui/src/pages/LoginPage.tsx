/**
 * Login page with explicit env picker — the user must consciously pick
 * the environment before authenticating. This is Safeguard #3
 * (Environment Lock-In) made visible at session start.
 *
 * UX Enhancements:
 * - Toast notifications for success/error feedback
 * - Keyboard accessible environment selector
 * - Clear validation and error states
 * - Loading indicators during async operations
 * - WCAG 2.2 AA accessibility compliance
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Environment } from '@latimer-woods-tech/studio-core';
import { useSession } from '../stores/session.js';
import { useNotifications } from '../stores/notifications.js';
import { getApiBase } from '../lib/api.js';

const ENV_CARDS: Array<{ env: Environment; title: string; subtitle: string; classes: string }> = [
  { env: 'local',      title: 'Local',      subtitle: 'Your dev box. Sandbox.',                 classes: 'bg-slate-800 hover:ring-slate-400'   },
  { env: 'staging',    title: 'Staging',    subtitle: 'Shared pre-prod. QA + integration.',     classes: 'bg-amber-900 hover:ring-amber-400'   },
  { env: 'production', title: 'Production', subtitle: 'LIVE traffic. Type-to-confirm enforced.', classes: 'bg-red-900 hover:ring-red-400'      },
];

/**
 * Resolve the Google Identity Services global once its async script has
 * loaded, polling up to `timeoutMs`. Resolves `null` if it never loads so
 * callers can fall back to manual login instead of hanging.
 */
function waitForGoogleIdentity(timeoutMs = 10_000): Promise<any> {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      const g = (window as any).google;
      if (g?.accounts?.id) {
        resolve(g);
      } else if (Date.now() - start >= timeoutMs) {
        resolve(null);
      } else {
        setTimeout(poll, 100);
      }
    };
    poll();
  });
}

export function LoginPage() {
  const [env, setEnv] = useState<Environment | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const login = useSession((s) => s.login);
  const addNotification = useNotifications((s) => s.add);
  const googleButtonRef = useRef<HTMLDivElement>(null);

  // Initialize Google Sign-In when env is selected
  useEffect(() => {
    if (!env || !googleButtonRef.current) return;

    let cancelled = false;

    async function initGSI() {
      // The GSI script is loaded with `async`, so `window.google` may not be
      // ready the moment an environment is selected. Wait for it (bounded)
      // instead of giving up immediately, otherwise the button never renders.
      const google = await waitForGoogleIdentity();
      if (cancelled || !googleButtonRef.current) return;
      if (!google) {
        addNotification({
          type: 'error',
          title: 'Google Sign-In Unavailable',
          message: 'Google Sign-In script failed to load. Please use the fallback login.',
          duration: 5000,
        });
        return;
      }

      // Fetch client_id from backend (it's a Cloudflare Worker secret, not baked into build)
      let googleClientId: string;
      try {
        const cfgRes = await fetch(`${getApiBase(env)}/auth/config`);
        const cfg = await cfgRes.json() as { googleClientId?: string | null };
        if (!cfg.googleClientId) {
          addNotification({ type: 'error', title: 'Google Sign-In not configured', message: 'GOOGLE_CLIENT_ID is missing on the worker. Set it via wrangler secret put.' });
          return;
        }
        googleClientId = cfg.googleClientId;
      } catch {
        addNotification({ type: 'error', title: 'Google Sign-In unavailable', message: 'Could not reach auth config endpoint.' });
        return;
      }

      if (cancelled || !googleButtonRef.current) return;
      // Clear any previously rendered button
      googleButtonRef.current.innerHTML = '';

      try {
        google.accounts.id.initialize({
          client_id: googleClientId,
          callback: handleGoogleCallback,
        });

        google.accounts.id.renderButton(googleButtonRef.current, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'pill',
          width: '320',
        });

        // Try to render the One Tap experience
        google.accounts.id.prompt(() => {
          // Prompt callback (notification is shown by Google)
        });
      } catch (err) {
        console.warn('Failed to initialize Google Sign-In:', err);
        addNotification({
          type: 'warning',
          title: 'Google Sign-In Issue',
          message: 'Could not fully initialize Google Sign-In. Using fallback login.',
        });
      }
    }

    void initGSI();

    return () => {
      cancelled = true;
    };
  }, [env, addNotification]);

  async function handleGoogleCallback(response: any) {
    if (!env) return;

    setSubmitting(true);

    try {
      const base = getApiBase(env);
      const res = await fetch(`${base}/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credential: response.credential || response,
          env,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        let msg = 'Authentication failed';
        let detail = '';
        try {
          const json = JSON.parse(text) as { error?: string; detail?: string };
          msg = json.error ?? msg;
          detail = json.detail ?? '';
        } catch {
          detail = `HTTP ${res.status}`;
        }
        throw new Error(detail ? `${msg}: ${detail}` : msg);
      }

      const data = (await res.json()) as { token: string; expiresAt: number };
      login(data.token, env, data.expiresAt);
      addNotification({
        type: 'success',
        title: 'Welcome back',
        message: `Logged in to ${env} with Google`,
        duration: 2000,
      });
      navigate(searchParams.get('next') ?? '/');
    } catch (err) {
      const msg = (err as Error).message || 'Google authentication failed';
      addNotification({
        type: 'error',
        title: 'Login Failed',
        message: msg,
        duration: 5000,
      });
      setSubmitting(false);
    }
  }

  function validateEmail(value: string): boolean {
    if (!value.trim()) {
      setEmailError('Email is required');
      return false;
    }
    const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    if (!isValid) {
      setEmailError('Please enter a valid email address');
      return false;
    }
    setEmailError('');
    return true;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!env || !validateEmail(email)) return;

    setSubmitting(true);

    try {
      const base = getApiBase(env);
      const res = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, env }),
      });

      if (!res.ok) {
        const text = await res.text();
        let msg = 'Login failed';
        try {
          const json = JSON.parse(text) as { error?: string };
          msg = json.error ?? msg;
        } catch {
          msg = `Login failed (${res.status})`;
        }
        throw new Error(msg);
      }

      const data = (await res.json()) as { token: string; expiresAt: number };
      login(data.token, env, data.expiresAt);
      addNotification({
        type: 'success',
        title: 'Welcome back',
        message: `Logged in to ${env}`,
        duration: 2000,
      });
      navigate(searchParams.get('next') ?? '/');
    } catch (err) {
      const msg = (err as Error).message || 'Login failed';
      addNotification({
        type: 'error',
        title: 'Login Failed',
        message: msg,
        duration: 5000,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm mx-auto">
        <h1 className="text-2xl font-bold text-white">Factory Admin Studio</h1>
        <p className="mt-1 text-sm text-slate-400">
          Step 1 — choose the environment you intend to operate against.
        </p>

        <fieldset className="mt-6">
          <legend className="sr-only">Select environment</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {ENV_CARDS.map((card) => (
              <button
                key={card.env}
                type="button"
                onClick={() => setEnv(card.env)}
                aria-pressed={env === card.env}
                aria-label={`${card.title} — ${card.subtitle}`}
                className={`${card.classes} rounded-lg p-4 text-left transition ring-1 ring-transparent focus:outline-none focus:ring-2 focus:ring-white ${
                  env === card.env ? 'ring-white' : ''
                }`}
              >
                <div className="text-base font-semibold text-white">{card.title}</div>
                <div className="mt-1 text-xs text-white/80">{card.subtitle}</div>
              </button>
            ))}
          </div>
        </fieldset>

        {env && (
          <div className="mt-8 space-y-6">
            <div>
              <p className="text-sm text-slate-400" role="status">
                Step 2 — sign in. You'll be locked to <strong>{env}</strong> until you sign out.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-white mb-3">Recommended</h2>
                <p className="text-xs text-white/80 mb-3">
                  Sign in with your allowlisted Google account. Verified Google identity is the primary production path.
                </p>
                <div 
                  className="flex justify-center" 
                  ref={googleButtonRef}
                  role="region"
                  aria-label="Google Sign-In button"
                />
              </div>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-slate-700" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-slate-950 text-slate-400">or</span>
                </div>
              </div>

              <div>
                <h2 className="text-sm font-semibold text-white mb-3">Fallback operator login</h2>
                <p className="text-xs text-white/80 mb-3">
                  Use the shared bootstrap password only for break-glass access or initial recovery.
                </p>

                <form onSubmit={handleSubmit} className="space-y-3" noValidate>
                  <div>
                    <label htmlFor="email" className="sr-only">
                      Email address
                    </label>
                    <input
                      id="email"
                      type="email"
                      required
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setEmailError('');
                      }}
                      onBlur={() => validateEmail(email)}
                      placeholder="email"
                      autoComplete="username"
                      aria-invalid={!!emailError}
                      aria-describedby={emailError ? 'email-error' : undefined}
                      disabled={submitting}
                      className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                    />
                    {emailError && (
                      <p id="email-error" className="mt-1 text-xs text-red-400">
                        {emailError}
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor="password" className="sr-only">
                      Password
                    </label>
                    <input
                      id="password"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="password"
                      autoComplete="current-password"
                      disabled={submitting}
                      className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={submitting || !env}
                    className="w-full rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400 transition"
                  >
                    {submitting ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="inline-block h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Signing in…
                      </span>
                    ) : (
                      `Sign in to ${env}`
                    )}
                  </button>
                </form>
              </div>
            </div>
          </div>
        )}

        <div className="mt-12 pt-8 border-t border-slate-700">
          <p className="text-xs text-slate-500">
            🔐 Security: Your session is locked to the selected environment. Session stored in memory; cleared on browser close.
          </p>
        </div>
      </div>
    </div>
  );
}
