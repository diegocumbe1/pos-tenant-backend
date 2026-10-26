import {
  decryptToken,
  encryptToken,
  signState,
  verifyState,
} from './google-calendar.crypto';

describe('google-calendar.crypto', () => {
  const previous = process.env.GOOGLE_TOKEN_ENC_KEY;
  beforeAll(() => {
    process.env.GOOGLE_TOKEN_ENC_KEY = 'ab'.repeat(32);
  });
  afterAll(() => {
    process.env.GOOGLE_TOKEN_ENC_KEY = previous;
  });

  const state = {
    tenantId: 't1',
    branchId: 'b1',
    staffId: 's1',
    returnTo: 'page' as const,
    exp: Date.now() + 60_000,
  };

  it('cifra y descifra el refresh token, sin dejarlo en claro', () => {
    const stored = encryptToken('1//refresh-token');
    expect(stored).not.toContain('refresh-token');
    expect(decryptToken(stored)).toBe('1//refresh-token');
  });

  it('el mismo token cifrado dos veces no se repite (iv aleatorio)', () => {
    expect(encryptToken('x')).not.toBe(encryptToken('x'));
  });

  it('el estado firmado vuelve igual', () => {
    expect(verifyState(signState(state))).toEqual(state);
  });

  it('rechaza un estado alterado: no se puede conectar a otro negocio', () => {
    const [, sig] = signState(state).split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...state, tenantId: 'otro' }),
    ).toString('base64url');
    expect(verifyState(`${forged}.${sig}`)).toBeNull();
  });

  it('rechaza un enlace vencido', () => {
    expect(
      verifyState(signState({ ...state, exp: Date.now() - 1 })),
    ).toBeNull();
  });

  it('exige una clave de 32 bytes', () => {
    process.env.GOOGLE_TOKEN_ENC_KEY = 'corta';
    expect(() => encryptToken('x')).toThrow(/32 bytes/);
    process.env.GOOGLE_TOKEN_ENC_KEY = 'ab'.repeat(32);
  });
});
