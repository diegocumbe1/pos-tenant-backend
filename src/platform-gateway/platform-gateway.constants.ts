/** Fila única de configuración (`PlatformGatewaySettings.id`). */
export const GATEWAY_SINGLETON_ID = 'singleton';

export const GATEWAY_ENVIRONMENTS = ['test', 'prod'] as const;
export type GatewayEnvironment = (typeof GATEWAY_ENVIRONMENTS)[number];

/**
 * Medios que tiene sentido habilitar en el checkout.
 *
 * Nequi, Daviplata, Bre-B y el QR de Bancolombia NO están aquí a propósito: se
 * reciben directo en la cuenta con comisión 0, y pasarlos por la pasarela es
 * regalar ~3,15% por algo que ya es gratis. Ver docs/PLAN_PASARELA_WOMPI.md §1.
 */
export const GATEWAY_METHODS = ['CARD', 'PSE'] as const;
export type GatewayMethod = (typeof GATEWAY_METHODS)[number];

/** Base del API de Wompi por ambiente. Las llaves no se cruzan entre ambientes. */
export const WOMPI_API_BASE: Record<GatewayEnvironment, string> = {
  test: 'https://sandbox.wompi.co/v1',
  prod: 'https://production.wompi.co/v1',
};

/** Prefijo que debe tener cada llave según el ambiente. */
export const WOMPI_KEY_PREFIX: Record<
  GatewayEnvironment,
  {
    publicKey: string;
    privateKey: string;
    eventsSecret: string;
    integritySecret: string;
  }
> = {
  test: {
    publicKey: 'pub_test_',
    privateKey: 'prv_test_',
    eventsSecret: 'test_events_',
    integritySecret: 'test_integrity_',
  },
  prod: {
    publicKey: 'pub_prod_',
    privateKey: 'prv_prod_',
    eventsSecret: 'prod_events_',
    integritySecret: 'prod_integrity_',
  },
};

/** Ruta del webhook que hay que pegar en "URL de Eventos" del dashboard. */
export const GATEWAY_WEBHOOK_PATH = '/platform/webhooks/wompi';
