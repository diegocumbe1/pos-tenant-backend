import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export function normalizeActivationPhrase(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function derive(phrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      normalizeActivationPhrase(phrase),
      salt,
      32,
      { N: 16384, r: 8, p: 1 },
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

export function isActivationHash(value: string): boolean {
  return /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(value);
}

export async function hashActivationPhrase(phrase: string): Promise<string> {
  const normalized = normalizeActivationPhrase(phrase);
  if (
    normalized.length < 12 ||
    normalized.length > 200 ||
    normalized.split(' ').length < 3
  ) {
    throw new Error('Usa al menos tres palabras y entre 12 y 200 caracteres.');
  }
  const salt = randomBytes(16);
  return `scrypt-v1$${salt.toString('hex')}$${(await derive(normalized, salt)).toString('hex')}`;
}

export async function verifyActivationPhrase(
  phrase: string,
  hash: string,
): Promise<boolean> {
  if (!isActivationHash(hash) || phrase.length > 500) return false;
  const [, salt, expected] = hash.split('$');
  return timingSafeEqual(
    await derive(phrase, Buffer.from(salt, 'hex')),
    Buffer.from(expected, 'hex'),
  );
}
