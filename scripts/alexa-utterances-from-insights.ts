/** Usage: npx ts-node scripts/alexa-utterances-from-insights.ts insights.json > utterances.json
 * Input is the GET /assistant/insights export. Samples are reviewed static vocabulary, never user text.
 * Merge these entries into the existing Alexa model, preserving its slots/types/built-in intents.
 */
import { readFileSync } from 'node:fs';
const samples: Record<string, string[]> = {
  sales_summary: [
    'cuánto vendí hoy',
    'cómo van las ventas esta semana',
    'ventas de {negocio} en {periodo}',
  ],
  out_of_stock: ['qué está agotado', 'qué productos no tengo'],
  low_stock: ['qué se está agotando', 'qué productos debo reponer'],
  inventory_value: ['cuánto vale mi inventario', 'cómo está mi inventario'],
  pending_payment: ['quién me debe', 'cuánto me deben'],
  pending_delivery: [
    'qué tengo por entregar',
    'cuántas entregas están pendientes',
  ],
  business_report: ['cómo va el negocio', 'dame el reporte de {negocio}'],
  product_lookup: ['busca {producto}', 'cuánto queda de {producto}'],
  top_products: ['cuáles son los productos más vendidos'],
  worst_products: ['qué productos no se venden'],
  top_customers: ['cuáles son mis mejores clientes'],
  catalog_overview: ['qué productos tengo'],
  catalog_category: ['qué tengo en {categoria}'],
};
const aliases: Record<string, string> = {
  business_summary: 'business_report',
  product_stock: 'product_lookup',
};
const input = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
  topIntents: { intentId: string; count: number }[];
};
if (!Array.isArray(input.topIntents))
  throw new Error('Expected topIntents array');
const counts = new Map<string, number>();
for (const row of input.topIntents) {
  if (
    typeof row.intentId !== 'string' ||
    !Number.isFinite(row.count) ||
    row.count < 0
  )
    continue;
  const id = Object.hasOwn(aliases, row.intentId)
    ? aliases[row.intentId]
    : row.intentId;
  if (Object.hasOwn(samples, id))
    counts.set(id, (counts.get(id) ?? 0) + row.count);
}
const intents = [...counts]
  .sort((a, b) => b[1] - a[1])
  .map(([name]) => ({ name, samples: samples[name] }));
process.stdout.write(JSON.stringify({ intents }, null, 2) + '\n');
