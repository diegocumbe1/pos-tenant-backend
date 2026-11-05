/**
 * De un nombre oído por Alexa al nombre real.
 *
 * El reconocimiento de voz en español no conoce las marcas: "Bella Chic" llega
 * como "bellachi" y "Lynko" como "linco" o "lingo". Los sinónimos del modelo
 * ayudan, pero solo existen para los negocios escritos a mano. Esto cubre a todos.
 */

/** Se compara sin tildes ni puntuación: Alexa transcribe distinto cada vez. */
export function normalizeSpoken(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Cómo suena en español: "lynko" y "linco" dan la misma clave. */
export function phoneticKey(value: string): string {
  return normalizeSpoken(value)
    .replace(/\s/g, '')
    .replace(/ch|sh/g, 'X')
    .replace(/ll/g, 'i')
    .replace(/qu/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/c(?=[ei])/g, 's')
    .replace(/[cq]/g, 'k')
    .replace(/z/g, 's')
    .replace(/v/g, 'b')
    .replace(/y/g, 'i')
    .replace(/w/g, 'u')
    .replace(/h/g, '')
    .replace(/g(?=[ei])/g, 'j')
    .replace(/(.)\1+/g, '$1');
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = row;
  }
  return previous[b.length];
}

/** Cuánto error se tolera: en un nombre corto, una letra ya es otro nombre. */
function tolerance(length: number): number {
  if (length >= 7) return 2;
  return length >= 5 ? 1 : 0;
}

export type NameMatch<T> =
  | { status: 'resolved'; business: T }
  | { status: 'ambiguous'; matches: T[] }
  | { status: 'unknown' };

/**
 * Del más estricto al más flexible, y se detiene en el primero que acierte: un
 * nombre exacto nunca compite con uno que apenas suena parecido. Si varios
 * empatan se pregunta, nunca se elige.
 */
export function matchBusinessName<T extends { name: string }>(
  available: T[],
  spoken: string,
): NameMatch<T> {
  const decide = (found: T[]): NameMatch<T> | null => {
    if (found.length === 1) return { status: 'resolved', business: found[0] };
    return found.length > 1 ? { status: 'ambiguous', matches: found } : null;
  };

  const said = normalizeSpoken(spoken);
  const exact = available.filter((b) => normalizeSpoken(b.name) === said);
  if (exact.length === 1) return { status: 'resolved', business: exact[0] };

  // Sin espacios también: el Echo pega las palabras y se come el final.
  const tight = said.replace(/\s/g, '');
  const partial = available.filter((b) => {
    const name = normalizeSpoken(b.name);
    const nameTight = name.replace(/\s/g, '');
    return (
      name.startsWith(said) ||
      said.startsWith(name) ||
      name.includes(said) ||
      nameTight.startsWith(tight) ||
      tight.startsWith(nameTight)
    );
  });
  const byText = decide(partial);
  if (byText) return byText;

  const key = phoneticKey(spoken);
  // Con menos de cuatro sonidos, casi cualquier nombre "se parece".
  if (key.length < 4) return { status: 'unknown' };
  const sameSound = available.filter((b) => phoneticKey(b.name) === key);
  const bySound = decide(sameSound);
  if (bySound) return bySound;

  const close = available.filter((b) => {
    const nameKey = phoneticKey(b.name);
    return (
      distance(nameKey, key) <= tolerance(Math.max(nameKey.length, key.length))
    );
  });
  return decide(close) ?? { status: 'unknown' };
}
