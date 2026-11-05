/** Forma mínima del JSON que recibe la consola de Amazon. */
export interface InteractionModel {
  interactionModel: {
    languageModel: {
      invocationName: string;
      intents: {
        name: string;
        slots?: { name: string; type: string }[];
        samples: string[];
      }[];
      types: { name: string; values: unknown[] }[];
    };
  };
}

/** Solo tienen sentido en la skill de plataforma, que ve varios negocios. */
export const PLATFORM_ONLY_INTENTS = [
  'GetSubscriptionsIntent',
  'list_businesses',
];

const BUSINESS_SLOT = 'negocio';
const BUSINESS_TYPE = 'BUSINESS';

/**
 * Amazon exige minúsculas y al menos dos palabras. Los dígitos también se
 * rechazan: hay que escribirlos como se pronuncian.
 */
export function assertInvocationName(name: string): void {
  if (!/^[a-záéíóúüñ]+( [a-záéíóúüñ]+)+$/.test(name)) {
    throw new Error(
      `Nombre de invocación inválido: "${name}". Usa dos o más palabras en minúsculas, sin números.`,
    );
  }
}

/**
 * El modelo de la skill de un negocio, derivado del de plataforma.
 *
 * Quita el slot de negocio y todas sus frases: la skill ya es el negocio, y
 * dejarlas haría que Alexa intentara reconocer nombres que no se van a usar.
 */
export function buildTenantModel(
  base: InteractionModel,
  invocationName: string,
): InteractionModel {
  assertInvocationName(invocationName);
  const { intents, types } = base.interactionModel.languageModel;
  return {
    interactionModel: {
      languageModel: {
        invocationName,
        intents: intents
          .filter((intent) => !PLATFORM_ONLY_INTENTS.includes(intent.name))
          .map((intent) =>
            intent.slots
              ? {
                  ...intent,
                  slots: intent.slots.filter((s) => s.name !== BUSINESS_SLOT),
                  samples: intent.samples.filter(
                    (sample) => !sample.includes(`{${BUSINESS_SLOT}}`),
                  ),
                }
              : intent,
          ),
        types: types.filter((type) => type.name !== BUSINESS_TYPE),
      },
    },
  };
}
