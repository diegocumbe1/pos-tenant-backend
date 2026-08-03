/**
 * Orígenes permitidos para CORS, desde `CORS_ORIGINS` (lista separada por
 * comas, sin slash final). Sin la env → `true`: refleja cualquier origen, que
 * es lo cómodo en local pero NO debe pasar en prod.
 *
 * Vive aparte porque Socket.IO no hereda el CORS de Nest: el gateway lleva su
 * propia config y hay que alimentar ambos con la misma lista.
 */
export function corsOrigins(): string[] | true {
  const list = process.env.CORS_ORIGINS?.split(',')
    // Se limpian comillas y slash final: pegar el valor entrecomillado en el
    // panel del hosting deja `"https://dominio.com` como origen y CORS falla
    // en silencio (sin Access-Control-Allow-Origin, "Failed to fetch" en el
    // navegador). Normalizar aquí evita depender de cómo se pegó la env.
    .map((o) =>
      o
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\/+$/, ''),
    )
    .filter(Boolean);
  return list && list.length > 0 ? list : true;
}
