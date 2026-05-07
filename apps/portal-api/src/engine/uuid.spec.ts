// SPDX-License-Identifier: AGPL-3.0-or-later
import { isUuid, uuidv7, uuidv7Timestamp } from '@gratis-gis/engine';

describe('uuidv7', () => {
  it('produces an RFC 9562 UUID string', () => {
    const id = uuidv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(isUuid(id)).toBe(true);
  });

  it('encodes the millisecond timestamp it was given', () => {
    const ts = 1_745_000_000_000; // arbitrary 2025-ish epoch ms
    const id = uuidv7(ts);
    expect(uuidv7Timestamp(id)).toBe(ts);
  });

  it('is monotonic across timestamps within the same generator process', () => {
    const a = uuidv7(1_000_000_000_000);
    const b = uuidv7(1_000_000_000_001);
    // String compare works because the timestamp lives in the high bits.
    expect(a < b).toBe(true);
  });

  it('sets the version 7 nibble', () => {
    const id = uuidv7();
    // 13th hex char (zero-indexed 12) is the version nibble.
    const stripped = id.replace(/-/g, '');
    expect(stripped[12]).toBe('7');
  });

  it('sets the variant bits to 10 (RFC 4122)', () => {
    const id = uuidv7();
    const stripped = id.replace(/-/g, '');
    const variantNibble = Number.parseInt(stripped[16] ?? '', 16);
    // High two bits must be 10, i.e. the nibble is 8, 9, a, or b.
    expect(variantNibble & 0xc).toBe(0x8);
  });
});

describe('isUuid', () => {
  it('accepts a v7 we just generated', () => {
    expect(isUuid(uuidv7())).toBe(true);
  });

  it('rejects strings that are the wrong shape', () => {
    expect(isUuid('not a uuid')).toBe(false);
    expect(isUuid('01234567-89ab-cdef')).toBe(false);
    expect(isUuid('')).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isUuid(123)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid({})).toBe(false);
  });
});

describe('uuidv7Timestamp', () => {
  it('returns null for non-v7 UUIDs', () => {
    // A v4 UUID has 4 in the version slot, not 7.
    expect(uuidv7Timestamp('00000000-0000-4000-8000-000000000000')).toBe(null);
  });

  it('returns null for malformed strings', () => {
    expect(uuidv7Timestamp('not a uuid')).toBe(null);
  });
});
