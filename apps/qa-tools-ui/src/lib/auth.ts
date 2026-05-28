/**
 * Client-side JWT management for QA Tools UI.
 *
 * The JWT is issued by the qa-tools-worker auth routes and stored
 * in sessionStorage so it persists across page navigations within a tab
 * but is cleared when the tab is closed.
 *
 * Usage:
 *   import { getToken, setToken, clearToken, isAuthenticated } from '@/lib/auth';
 */

const TOKEN_KEY = 'qa_tools_jwt';

/** Retrieve the stored JWT, or null if not authenticated. */
export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

/** Store the JWT (called after successful login). */
export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

/** Remove the JWT (logout). */
export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/** Returns true if a JWT is stored (does not validate the signature). */
export function isAuthenticated(): boolean {
  return getToken() !== null;
}

/**
 * Returns Authorization header value, or throws if not authenticated.
 * Use this in API calls.
 */
export function getAuthHeader(): string {
  const token = getToken();
  if (!token) throw new Error('Not authenticated — no JWT in sessionStorage');
  return `Bearer ${token}`;
}

/**
 * Decode the JWT payload (no signature verification — client-side only).
 * Returns null on any parsing error.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    if (!payload) return null;
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4;
    const padded2 = pad > 0 ? padded + '='.repeat(4 - pad) : padded;
    return JSON.parse(atob(padded2)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract the email claim from the stored JWT for display purposes. */
export function getStoredEmail(): string | null {
  const token = getToken();
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  return typeof payload['email'] === 'string' ? payload['email'] : null;
}

/** Extract the role claim from the stored JWT. */
export function getStoredRole(): string | null {
  const token = getToken();
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  return typeof payload['role'] === 'string' ? payload['role'] : null;
}
