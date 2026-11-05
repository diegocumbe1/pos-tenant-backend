/**
 * Imprime el modelo de interacción listo para pegar en la consola de Amazon.
 * No toca la base de datos ni la consola. Ver alexa/README.md.
 *
 *   npm run --silent alexa:model -- --tenant --name "mi panel de belleza" > bella-chic.json
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertInvocationName,
  buildTenantModel,
  InteractionModel,
} from '../src/integrations/alexa/interaction-model';

const args = process.argv.slice(2);
const nameIndex = args.indexOf('--name');
const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
const tenant = args.includes('--tenant');

const base = JSON.parse(
  readFileSync(join(__dirname, '../alexa/interaction-model.json'), 'utf8'),
) as InteractionModel;

try {
  if (tenant && !name) throw new Error('Una skill de negocio exige --name.');
  if (name) assertInvocationName(name);
  const model = tenant ? buildTenantModel(base, name as string) : base;
  if (!tenant && name)
    model.interactionModel.languageModel.invocationName = name;
  process.stdout.write(`${JSON.stringify(model, null, 2)}\n`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
