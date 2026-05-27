/**
 * AES-256-GCM credential encryption for qa-tools-worker.
 *
 * Uses the Web Crypto API exclusively — no Node.js `crypto` module.
 * The encryption key is a 64-character hex string (32 bytes) stored as
 * the `QA_TOOLS_ENCRYPT_KEY` Worker secret.
 *
 * Ciphertext format (stored in Neon): `{iv_hex}:{ciphertext_hex}`
 *   - IV: 12 random bytes (96-bit, GCM standard)
 *   - Ciphertext: AES-256-GCM output (includes 16-byte authentication tag)
 *
 * Credential payload JSON shape (before encryption):
 *   { username, password, mfaSecret?, additionalHeaders? }
 *
 * See: docs/architecture/QA_TOOLS_ARCHITECTURE.md §6.1
 */

import { InternalError, ValidationError } from '@latimer-woods-tech/errors';

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new InternalError('Invalid hex string length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Imports the raw 32-byte hex key as a CryptoKey for AES-256-GCM.
 * The `QA_TOOLS_ENCRYPT_KEY` secret must be exactly 64 hex characters.
 */
async function importKey(hexKey: string): Promise<CryptoKey> {
  if (hexKey.length !== 64) {
    throw new InternalError(
      `QA_TOOLS_ENCRYPT_KEY must be 64 hex characters (32 bytes); got ${String(hexKey.length)}`,
    );
  }
  const keyBytes = hexToBytes(hexKey);
  return crypto.subtle.importKey(
    'raw',
    keyBytes.buffer as ArrayBuffer,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

/**
 * Encrypts a credential payload object as AES-256-GCM.
 *
 * @param payload - The credential data to encrypt (will be JSON-serialized)
 * @param hexKey  - 64-char hex encoding of the 32-byte AES key
 * @returns Encrypted string in `{iv_hex}:{ciphertext_hex}` format
 */
export async function encryptCredential(
  payload: CredentialPayload,
  hexKey: string,
): Promise<string> {
  const key = await importKey(hexKey);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer },
    key,
    plaintext.buffer,
  );

  return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(ciphertext))}`;
}

// ---------------------------------------------------------------------------
// Decryption
// ---------------------------------------------------------------------------

/**
 * Decrypts an AES-256-GCM encrypted credential payload.
 *
 * @param encrypted - String in `{iv_hex}:{ciphertext_hex}` format
 * @param hexKey    - 64-char hex encoding of the 32-byte AES key
 * @returns Decrypted {@link CredentialPayload}
 * @throws {@link InternalError} on malformed ciphertext or decryption failure
 */
export async function decryptCredential(
  encrypted: string,
  hexKey: string,
): Promise<CredentialPayload> {
  const colonIdx = encrypted.indexOf(':');
  if (colonIdx < 0) {
    throw new InternalError('Encrypted credential format is invalid (missing colon separator)');
  }
  const ivHex = encrypted.slice(0, colonIdx);
  const ciphertextHex = encrypted.slice(colonIdx + 1);

  if (ivHex.length !== 24) {
    throw new InternalError('Encrypted credential has invalid IV length (expected 12 bytes / 24 hex chars)');
  }

  const key = await importKey(hexKey);
  const iv = hexToBytes(ivHex);
  const ciphertext = hexToBytes(ciphertextHex);

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
      key,
      ciphertext.buffer as ArrayBuffer,
    );
  } catch {
    throw new InternalError('Credential decryption failed (wrong key or tampered ciphertext)');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new InternalError('Decrypted credential is not valid JSON');
  }

  return validateCredentialPayload(payload);
}

// ---------------------------------------------------------------------------
// Payload types and validation
// ---------------------------------------------------------------------------

/** The decrypted shape stored in AES-GCM ciphertext. */
export interface CredentialPayload {
  /** Login username or email address. */
  username: string;
  /** Login password. */
  password: string;
  /** Optional TOTP secret (base32) for MFA flows. */
  mfaSecret?: string;
  /** Optional HTTP headers to inject on every page load (e.g. API keys). */
  additionalHeaders?: Record<string, string>;
}

/**
 * Validates and narrows an unknown value to {@link CredentialPayload}.
 * Throws {@link ValidationError} if required fields are missing or wrong type.
 */
export function validateCredentialPayload(raw: unknown): CredentialPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('Credential payload must be an object');
  }
  const p = raw as Record<string, unknown>;

  if (typeof p['username'] !== 'string' || p['username'].length === 0) {
    throw new ValidationError('Credential payload must have a non-empty username');
  }
  if (typeof p['password'] !== 'string' || p['password'].length === 0) {
    throw new ValidationError('Credential payload must have a non-empty password');
  }

  const result: CredentialPayload = {
    username: p['username'],
    password: p['password'],
  };

  if (p['mfaSecret'] !== undefined) {
    if (typeof p['mfaSecret'] !== 'string') throw new ValidationError('mfaSecret must be a string');
    result.mfaSecret = p['mfaSecret'];
  }

  if (p['additionalHeaders'] !== undefined) {
    if (typeof p['additionalHeaders'] !== 'object' || Array.isArray(p['additionalHeaders'])) {
      throw new ValidationError('additionalHeaders must be an object');
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(p['additionalHeaders'] as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new ValidationError(`additionalHeaders.${k} must be a string`);
      headers[k] = v;
    }
    result.additionalHeaders = headers;
  }

  return result;
}
