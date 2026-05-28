/**
 * Login page.
 *
 * Uses the same operator credential policy as Admin Studio:
 * allowlisted Google Workspace sign-in first, bootstrap email/password only
 * for break-glass access.
 */

'use client';

import { useEffect, useRef, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthConfig, loginWithGoogle, loginWithPassword } from '@/lib/api';
import { setToken, isAuthenticated } from '@/lib/auth';

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          disableAutoSelect?: () => void;
          initialize: (options: { client_id: string; callback: (response: { credential?: string }) => void; auto_select?: boolean }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, string>) => void;
        };
      };
    };
  }
}

function waitForGoogleIdentity(timeoutMs = 10_000): Promise<typeof window.google | null> {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      if (window.google?.accounts?.id) {
        resolve(window.google);
      } else if (Date.now() - start >= timeoutMs) {
        resolve(null);
      } else {
        setTimeout(poll, 100);
      }
    };
    poll();
  });
}

export default function LoginPage() {
  const router = useRouter();
  const googleButtonRef = useRef<HTMLDivElement>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);

  useEffect(() => {
    if (isAuthenticated()) router.replace('/');
  }, [router]);

  useEffect(() => {
    let cancelled = false;

    async function initGoogle() {
      setError(null);
      const google = await waitForGoogleIdentity();
      if (cancelled || !googleButtonRef.current) return;
      if (!google?.accounts?.id) {
        setError('Google Sign-In did not load. Use break-glass login if you need access now.');
        return;
      }

      try {
        const config = await getAuthConfig();
        if (!config.googleClientId) {
          setError('Google Sign-In is not configured on the QA Tools API.');
          return;
        }

        google.accounts.id.disableAutoSelect?.();
        google.accounts.id.initialize({
          client_id: config.googleClientId,
          callback: (response) => void handleGoogleCredential(response.credential),
          auto_select: false,
        });

        googleButtonRef.current.innerHTML = '';
        google.accounts.id.renderButton(googleButtonRef.current, {
          theme: 'outline',
          size: 'large',
          text: 'continue_with',
          shape: 'pill',
          width: '320',
        });
        setGoogleReady(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not initialize Google Sign-In.');
      }
    }

    void initGoogle();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleGoogleCredential(credential?: string) {
    if (!credential) {
      setError('Google did not return a credential.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const session = await loginWithGoogle(credential);
      setToken(session.token);
      router.replace('/');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const session = await loginWithPassword(email, password);
      setToken(session.token);
      router.replace('/');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto mt-20 max-w-md">
      <div className="card">
        <h1 className="text-xl text-gray-900 mb-1">Sign in to QA Tools</h1>
        <p className="text-sm text-gray-500 mb-6">
          Use your allowlisted Latimer Woods Google account.
        </p>

        <div className="space-y-4">
          <div>
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-500">
              Recommended
            </p>
            <div
              ref={googleButtonRef}
              className="flex min-h-10 justify-center"
              aria-busy={!googleReady}
              aria-label="Google Sign-In"
            />
          </div>

          <div className="relative py-2">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-100" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-white px-2 text-gray-400">or</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3" noValidate>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
              Break-glass fallback
            </p>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email"
              autoComplete="username"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="password"
              autoComplete="current-password"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <button
              type="submit"
              disabled={submitting || !email || !password}
              className="btn-primary w-full justify-center"
            >
              {submitting ? 'Signing in...' : 'Sign in'}
            </button>
          </form>
        </div>

        {error && (
          <p className="mt-4 text-xs text-red-600 rounded-md bg-red-50 border border-red-200 px-3 py-2">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Login failed.';
  try {
    const body = JSON.parse(error.message.replace(/^API error \d+:\s*/, '')) as { error?: string; detail?: string; message?: string };
    return body.detail || body.message || body.error || 'Login failed.';
  } catch {
    return error.message;
  }
}
