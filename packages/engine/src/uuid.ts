// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UUIDv7 generator. Postgres 16 does not ship a native `uuidv7()` function
// (Postgres 17 does, and the `pg_uuidv7` extension covers older versions),
// so we generate ids in app code on the write path. The format follows
// RFC 9562 section 5.7:
//
//   ttttttttttttttttttttttttvvvvxxxxxxxxxxxxxx...
//   |---48 bit unix ms------||4 bit version  ||62 bit random + 2 bit variant|
//
// The 48-bit timestamp is the Unix epoch in milliseconds. Two ids generated
// within the same millisecond are still ordered by the random tail, so a
// strict per-process monotonic counter is not needed for our load (a single
// portal-api can generate roughly 10k ids per ms before collision risk
// becomes interesting, which is well above any realistic write rate).

import { randomBytes } from 'node:crypto';

/**
 * Generate a UUIDv7 as a lowercase string with dashes.
 *
 * @param now Optional override for the timestamp, used by tests.
 */
export function uuidv7(now?: number): string {
  const ts = BigInt(now ?? Date.now());
  // 10 random bytes fill the version + variant + tail.
  const r = randomBytes(10);

  // Place the 48-bit timestamp into the first 6 bytes.
  const out = Buffer.alloc(16);
  out[0] = Number((ts >> 40n) & 0xffn);
  out[1] = Number((ts >> 32n) & 0xffn);
  out[2] = Number((ts >> 24n) & 0xffn);
  out[3] = Number((ts >> 16n) & 0xffn);
  out[4] = Number((ts >> 8n) & 0xffn);
  out[5] = Number(ts & 0xffn);

  // Bytes 6-15 are random, except the version nibble (top of byte 6) and
  // the variant nibble (top of byte 8) which are fixed by the spec.
  out[6] = (r[0]! & 0x0f) | 0x70; // version 7
  out[7] = r[1]!;
  out[8] = (r[2]! & 0x3f) | 0x80; // variant 10
  out[9] = r[3]!;
  out[10] = r[4]!;
  out[11] = r[5]!;
  out[12] = r[6]!;
  out[13] = r[7]!;
  out[14] = r[8]!;
  out[15] = r[9]!;

  const hex = out.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

/**
 * Extract the timestamp encoded in a UUIDv7 string. Returns `null` if the
 * input is not a UUIDv7 (wrong version field).
 */
export function uuidv7Timestamp(uuid: string): number | null {
  const stripped = uuid.replace(/-/g, '');
  if (stripped.length !== 32) return null;
  // Version nibble is the 13th hex digit (zero-indexed 12).
  if (stripped[12] !== '7') return null;
  const tsHex = stripped.slice(0, 12);
  return Number.parseInt(tsHex, 16);
}

/**
 * RFC 9562 UUID format check: 8-4-4-4-12 hex with dashes. Does not validate
 * the version or variant fields.
 */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
