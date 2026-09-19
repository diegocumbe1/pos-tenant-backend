import { randomInt } from 'node:crypto';

/**
 * Alfabeto del código: sin 0/O/o, sin 1/l/I. El código viaja impreso DEBAJO del
 * QR, y tarde o temprano alguien lo teclea en vez de escanearlo; un cero que se
 * lee como O manda a una página de "enlace no disponible" que nadie sabe
 * explicar.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** Largo de la parte aleatoria. 54^7 ≈ 1.4e12: no se recorre a fuerza bruta. */
const RANDOM_LENGTH = 7;

/** Máximo de letras que aporta el negocio al prefijo ("bc-", "bella-"). */
const PREFIX_MAX = 3;

/**
 * Iniciales del negocio, para que el superadmin reconozca el código de un
 * vistazo entre veinte. Es decoración: la unicidad la da la parte aleatoria.
 */
export function qrPrefixFrom(name: string): string {
  const words = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return 'ly';
  // Varias palabras → iniciales (Bella Chic → bc). Una sola → sus 3 primeras
  // letras (Monserrate → mon).
  const prefix =
    words.length > 1
      ? words.map((word) => word[0]).join('')
      : words[0].slice(0, PREFIX_MAX);

  return prefix.slice(0, PREFIX_MAX);
}

/** Parte aleatoria, con `randomInt` (uniforme) y no `Math.random()`. */
export function qrRandomPart(length = RANDOM_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

/**
 * Código completo: `bc-A7kPq92`.
 *
 * No incluye NADA derivado de la base ni del negocio más allá del prefijo
 * cosmético: ni ids, ni slug, ni consecutivos. El slug cambia, el nombre cambia;
 * el cartón impreso no.
 */
export function buildQrCode(name: string): string {
  return `${qrPrefixFrom(name)}-${qrRandomPart()}`;
}

/** Igual que el regex del DTO: lo que el redirect público acepta buscar. */
export const QR_CODE_REGEX = /^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/;

/**
 * Convierte el destino guardado en una URL absoluta para redirigir.
 *
 * Los destinos se guardan relativos ("/sites/bella-chic") siempre que se pueda:
 * así la MISMA fila apunta a localhost en desarrollo y a uselynko.com en
 * producción, en vez de mandar a QA al sitio de producción.
 */
export function resolveQrTarget(targetUrl: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (/^https?:\/\//i.test(targetUrl)) return targetUrl;
  return `${base}${targetUrl.startsWith('/') ? '' : '/'}${targetUrl}`;
}

/** La URL que se codifica en el QR. Nunca el destino: esa es la que cambia. */
export function buildQrScanUrl(code: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/q/${code}`;
}

/**
 * Valida un destino ANTES de guardarlo.
 *
 * Solo rutas internas o http(s) absolutos. Sin esto, un `javascript:` guardado
 * por error convierte un link que la gente escanea a ciegas en un vector de
 * ejecución; y un destino inválido no se descubre hasta que el cliente llama
 * diciendo que su tarjeta no funciona.
 */
export function assertValidQrTarget(targetUrl: string): string {
  const value = targetUrl.trim();
  if (!value) throw new Error('El destino no puede estar vacío');

  if (value.startsWith('/')) {
    // "//evil.com" es una URL protocol-relative: se ve como ruta interna y sale
    // del dominio.
    if (value.startsWith('//')) {
      throw new Error('El destino no puede empezar con //');
    }
    return value;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      'El destino debe ser una ruta interna (/sites/mi-negocio) o una URL http(s) completa',
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('El destino solo admite http o https');
  }
  return parsed.toString();
}
