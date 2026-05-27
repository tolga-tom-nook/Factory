/**
 * Unit tests for lib/crypto.ts
 *
 * Uses the Web Crypto API which is available in Node.js 18+.
 * No external mocking required — the entire module runs in-process.
 */

import { describe, it, expect } from 'vitest';
import {
  encryptCredential,
  decryptCredential,
  validateCredentialPayload,
} from '../../src/lib/crypto.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A valid 64-hex-char (32-byte) test key. */
const TEST_KEY = 'a'.repeat(64);

const SAMPLE_PAYLOAD = {
  username: 'qa-admin@example.com',
  password: 'super-secret-pw!',
};

const FULL_PAYLOAD = {
  username: 'qa@example.com',
  password: 'p4ssw0rd',
  mfaSecret: 'JBSWY3DPEHPK3PXP',
  additionalHeaders: { 'X-Test-Header': 'value' },
};

// ---------------------------------------------------------------------------
// encryptCredential + decryptCredential round-trip
// ---------------------------------------------------------------------------

describe('encryptCredential / decryptCredential', () => {
  it('round-trips a minimal payload', async () => {
    const encrypted = await encryptCredential(SAMPLE_PAYLOAD, TEST_KEY);
    const decrypted = await decryptCredential(encrypted, TEST_KEY);
    expect(decrypted.username).toBe(SAMPLE_PAYLOAD.username);
    expect(decrypted.password).toBe(SAMPLE_PAYLOAD.password);
    expect(decrypted.mfaSecret).toBeUndefined();
    expect(decrypted.additionalHeaders).toBeUndefined();
  });

  it('round-trips a full payload with mfa + headers', async () => {
    const encrypted = await encryptCredential(FULL_PAYLOAD, TEST_KEY);
    const decrypted = await decryptCredential(encrypted, TEST_KEY);
    expect(decrypted.username).toBe(FULL_PAYLOAD.username);
    expect(decrypted.password).toBe(FULL_PAYLOAD.password);
    expect(decrypted.mfaSecret).toBe(FULL_PAYLOAD.mfaSecret);
    expect(decrypted.additionalHeaders).toEqual(FULL_PAYLOAD.additionalHeaders);
  });

  it('produces different ciphertext on each call (unique IV)', async () => {
    const enc1 = await encryptCredential(SAMPLE_PAYLOAD, TEST_KEY);
    const enc2 = await encryptCredential(SAMPLE_PAYLOAD, TEST_KEY);
    expect(enc1).not.toBe(enc2);
  });

  it('ciphertext format is {iv_hex}:{ciphertext_hex}', async () => {
    const encrypted = await encryptCredential(SAMPLE_PAYLOAD, TEST_KEY);
    const parts = encrypted.split(':');
    expect(parts.length).toBe(2);
    // IV is 12 bytes → 24 hex chars
    expect(parts[0]).toHaveLength(24);
    // Ciphertext is non-empty
    expect(parts[1]!.length).toBeGreaterThan(0);
    // Both parts are valid hex
    expect(/^[0-9a-f]+$/i.test(parts[0]!)).toBe(true);
    expect(/^[0-9a-f]+$/i.test(parts[1]!)).toBe(true);
  });

  it('throws InternalError on wrong key', async () => {
    const encrypted = await encryptCredential(SAMPLE_PAYLOAD, TEST_KEY);
    const wrongKey = 'b'.repeat(64);
    await expect(decryptCredential(encrypted, wrongKey)).rejects.toThrow(
      'Credential decryption failed',
    );
  });

  it('throws InternalError on tampered ciphertext', async () => {
    const encrypted = await encryptCredential(SAMPLE_PAYLOAD, TEST_KEY);
    // Flip the last character to corrupt the auth tag
    const tampered = encrypted.slice(0, -1) + (encrypted.endsWith('0') ? '1' : '0');
    await expect(decryptCredential(tampered, TEST_KEY)).rejects.toThrow(
      'Credential decryption failed',
    );
  });

  it('throws InternalError on missing colon separator', async () => {
    await expect(decryptCredential('nocolonseparator', TEST_KEY)).rejects.toThrow(
      'missing colon separator',
    );
  });

  it('throws InternalError on invalid IV length', async () => {
    // 6-byte IV (12 hex chars) instead of 12 bytes
    const badIv = 'a'.repeat(12) + ':' + 'b'.repeat(64);
    await expect(decryptCredential(badIv, TEST_KEY)).rejects.toThrow(
      'invalid IV length',
    );
  });

  it('throws InternalError when key is not 64 hex chars', async () => {
    await expect(encryptCredential(SAMPLE_PAYLOAD, 'tooshort')).rejects.toThrow(
      'must be 64 hex characters',
    );
  });
});

// ---------------------------------------------------------------------------
// validateCredentialPayload
// ---------------------------------------------------------------------------

describe('validateCredentialPayload', () => {
  it('accepts a valid minimal payload', () => {
    const result = validateCredentialPayload({ username: 'user@x.com', password: 'pw' });
    expect(result.username).toBe('user@x.com');
    expect(result.password).toBe('pw');
  });

  it('accepts a payload with all optional fields', () => {
    const result = validateCredentialPayload({
      username: 'u@x.com',
      password: 'pw',
      mfaSecret: 'SECRET',
      additionalHeaders: { 'X-Foo': 'bar' },
    });
    expect(result.mfaSecret).toBe('SECRET');
    expect(result.additionalHeaders).toEqual({ 'X-Foo': 'bar' });
  });

  it('throws ValidationError for non-object input', () => {
    expect(() => validateCredentialPayload('string')).toThrow('must be an object');
    expect(() => validateCredentialPayload(null)).toThrow('must be an object');
    expect(() => validateCredentialPayload([1, 2])).toThrow('must be an object');
  });

  it('throws ValidationError for missing username', () => {
    expect(() => validateCredentialPayload({ password: 'pw' })).toThrow('non-empty username');
  });

  it('throws ValidationError for empty username', () => {
    expect(() => validateCredentialPayload({ username: '', password: 'pw' })).toThrow('non-empty username');
  });

  it('throws ValidationError for missing password', () => {
    expect(() => validateCredentialPayload({ username: 'u@x.com' })).toThrow('non-empty password');
  });

  it('throws ValidationError for non-string mfaSecret', () => {
    expect(() =>
      validateCredentialPayload({ username: 'u@x.com', password: 'pw', mfaSecret: 123 }),
    ).toThrow('mfaSecret must be a string');
  });

  it('throws ValidationError for non-object additionalHeaders', () => {
    expect(() =>
      validateCredentialPayload({ username: 'u@x.com', password: 'pw', additionalHeaders: 'bad' }),
    ).toThrow('additionalHeaders must be an object');
  });

  it('throws ValidationError for non-string header value', () => {
    expect(() =>
      validateCredentialPayload({
        username: 'u@x.com',
        password: 'pw',
        additionalHeaders: { 'X-Foo': 42 },
      }),
    ).toThrow('additionalHeaders.X-Foo must be a string');
  });
});
