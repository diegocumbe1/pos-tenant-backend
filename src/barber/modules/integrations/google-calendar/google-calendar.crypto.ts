import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * El refresh token de Google da acceso al calendario de una persona: se guarda
 * cifrado (AES-256-GCM) con `GOOGLE_TOKEN_ENC_KEY` (32 bytes en hex). Si la
 * clave cambia, los tokens guardados dejan de abrir y hay que volver a conectar.
 */
function encryptionKey(): Buffer {
  const hex = process.env.GOOGLE_TOKEN_ENC_KEY ?? '';
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      'GOOGLE_TOKEN_ENC_KEY debe ser de 32 bytes en hex (openssl rand -hex 32)',
    );
  }
  return key;
}

/** `iv.tag.cifrado`, cada parte en base64url. */
export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map((part) => part.toString('base64url'))
    .join('.');
}

export function decryptToken(stored: string): string {
  const [iv, tag, data] = stored
    .split('.')
    .map((part) => Buffer.from(part, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * Lo que viaja en el `state` de OAuth y en el enlace que se le manda al
 * especialista: a qué negocio y a quién se conecta el calendario. Va firmado,
 * así que nadie puede cambiarlo para conectar su Google a otro negocio.
 */
export type ConnectState = {
  tenantId: string;
  branchId: string;
  /** null = calendario del negocio. */
  staffId: string | null;
  /** 'settings' vuelve a Ajustes; 'page' muestra una página de "listo". */
  returnTo: 'settings' | 'page';
  exp: number;
};

function signingKey(): Buffer {
  // Derivada para no reutilizar la clave de cifrado tal cual.
  return createHmac('sha256', encryptionKey()).update('connect-state').digest();
}

export function signState(state: ConnectState): string {
  const body = Buffer.from(JSON.stringify(state)).toString('base64url');
  const sig = createHmac('sha256', signingKey())
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

/** null si la firma no cuadra o ya venció. */
export function verifyState(token: string): ConnectState | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', signingKey()).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  try {
    const state = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as ConnectState;
    return state.exp > Date.now() ? state : null;
  } catch {
    return null;
  }
}
