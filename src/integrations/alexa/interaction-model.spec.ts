import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertInvocationName,
  buildTenantModel,
  InteractionModel,
  PLATFORM_ONLY_INTENTS,
} from './interaction-model';

const base = JSON.parse(
  readFileSync(
    join(__dirname, '../../../alexa/interaction-model.json'),
    'utf8',
  ),
) as InteractionModel;
const language = base.interactionModel.languageModel;

/** Los `case` de `handleIntent`: lo único que el backend sabe responder. */
const handled = (): string[] => {
  const source = readFileSync(join(__dirname, 'alexa.service.ts'), 'utf8');
  const start = source.indexOf('private async handleIntent(');
  const end = source.indexOf('/** Never logs or echoes', start);
  return [...source.slice(start, end).matchAll(/case '([\w.]+)':/g)].map(
    (match) => match[1],
  );
};

describe('modelo de interacción', () => {
  it('cada intent del modelo tiene quien lo responda', () => {
    const cases = handled();
    expect(
      language.intents.map((i) => i.name).filter((n) => !cases.includes(n)),
    ).toEqual([]);
  });

  it('cada intent propio del backend está en el modelo', () => {
    const names = language.intents.map((i) => i.name);
    expect(
      handled().filter((n) => !n.startsWith('AMAZON.') && !names.includes(n)),
    ).toEqual([]);
  });

  it('toda frase usa slots declarados, y todo slot usa un tipo existente', () => {
    const types = language.types.map((t) => t.name);
    for (const intent of language.intents) {
      const slots = (intent.slots ?? []).map((s) => s.name);
      for (const sample of intent.samples) {
        for (const [, slot] of sample.matchAll(/\{(\w+)\}/g)) {
          expect(slots).toContain(slot);
        }
      }
      for (const slot of intent.slots ?? []) {
        if (!slot.type.startsWith('AMAZON.'))
          expect(types).toContain(slot.type);
      }
    }
  });

  it('el modelo de un negocio no conserva nada de plataforma', () => {
    const tenant = buildTenantModel(base, 'mi panel de belleza')
      .interactionModel.languageModel;
    const text = JSON.stringify(tenant);

    expect(tenant.invocationName).toBe('mi panel de belleza');
    expect(text).not.toContain('{negocio}');
    expect(text).not.toContain('"BUSINESS"');
    for (const name of PLATFORM_ONLY_INTENTS) expect(text).not.toContain(name);
    // Ningún intent con frases propias queda vacío al quitarle las de negocio.
    for (const intent of tenant.intents) {
      if (intent.slots?.length)
        expect(intent.samples.length).toBeGreaterThan(0);
    }
  });

  it.each(['Mi Panel', 'panel', 'mi panel 2'])(
    'rechaza el nombre "%s"',
    (name) => {
      expect(() => assertInvocationName(name)).toThrow();
    },
  );
});
