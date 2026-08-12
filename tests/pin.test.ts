import { describe, expect, it } from 'vitest';
import {
  assertPinFormat,
  createPinCredentials,
  derivePinHash,
} from '../src/auth/pin';

const PEPPER_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const PEPPER_B = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const SALT_A = 'AgICAgICAgICAgICAgICAg==';
const SALT_B = 'AwMDAwMDAwMDAwMDAwMDAw==';

describe('PIN hashing', () => {
  it('accepts only 4 to 10 decimal digits', () => {
    expect(() => assertPinFormat('1234')).not.toThrow();
    expect(() => assertPinFormat('1234567890')).not.toThrow();
    expect(() => assertPinFormat('123')).toThrow('bad_request');
    expect(() => assertPinFormat('12345678901')).toThrow('bad_request');
    expect(() => assertPinFormat('12a4')).toThrow('bad_request');
  });

  it('is deterministic but bound to both salt and server-side pepper', async () => {
    const first = await derivePinHash('123456', SALT_A, PEPPER_A);
    await expect(derivePinHash('123456', SALT_A, PEPPER_A)).resolves.toBe(first);
    await expect(derivePinHash('123456', SALT_B, PEPPER_A)).resolves.not.toBe(first);
    await expect(derivePinHash('123456', SALT_A, PEPPER_B)).resolves.not.toBe(first);
    await expect(derivePinHash('654321', SALT_A, PEPPER_A)).resolves.not.toBe(first);
  });

  it('creates a fresh HMAC-v1 credential record', async () => {
    const first = await createPinCredentials('123456', PEPPER_A);
    const second = await createPinCredentials('123456', PEPPER_A);

    expect(first.pinIterations).toBe(0);
    expect(first.pinSalt).not.toBe(second.pinSalt);
    expect(first.pinHash).not.toBe(second.pinHash);
  });

  it('rejects a malformed server-side pepper', async () => {
    await expect(derivePinHash('123456', SALT_A, 'too-short')).rejects.toThrow(
      'PIN pepper is not valid base64',
    );
  });
});
