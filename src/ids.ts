import { randomBytes, randomUUID } from 'node:crypto';

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * The pairing code the delegate reads out and the relative repeats to their own Echo.
 * No vowels, so it cannot spell anything, and no characters that sound alike when
 * spoken: B and P, M and N, S and F are all dropped rather than risk a mis-hearing
 * being logged as a consent.
 */
const CODE_ALPHABET = '234679CDGHJKRTWXYZ';

export function pairingCode(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function token(): string {
  return randomBytes(32).toString('base64url');
}

/** Human-facing booking reference. Appears in voice readback and in the email. */
export function reference(): string {
  const bytes = randomBytes(4);
  return `SB-${Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')}`;
}
