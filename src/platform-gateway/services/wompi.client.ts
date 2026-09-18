import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GatewayEnvironment,
  WOMPI_API_BASE,
} from '../platform-gateway.constants';
import {
  BuiltCheckout,
  CheckoutCustomer,
  buildCheckoutUrl,
  copToCents,
} from '../checkout-url';
import {
  WompiTransactionView,
  readPath,
  readTransaction,
} from '../event-checksum';
import { GatewaySettingsService } from './gateway-settings.service';

export interface KeyCheck {
  /** true = la llave sirve; false = Wompi la rechazó; null = no se pudo saber. */
  ok: boolean | null;
  detail: string;
}

export interface ConnectionTest {
  environment: GatewayEnvironment;
  apiBase: string;
  /** Nombre del comercio según Wompi. Confirma que estás en la cuenta correcta. */
  merchantName: string | null;
  publicKey: KeyCheck;
  privateKey: KeyCheck;
}

const TIMEOUT_MS = 10_000;

/**
 * Cliente de Wompi: prueba de conexión y armado del link de pago.
 *
 * Falta el webhook y la consulta de una transacción por id (pasos 6-7 de
 * docs/PLAN_PASARELA_WOMPI.md).
 */
@Injectable()
export class WompiClient {
  private readonly logger = new Logger(WompiClient.name);

  constructor(private readonly settings: GatewaySettingsService) {}

  /**
   * Link de pago para un cobro concreto. La referencia es nuestra y es la que
   * vuelve en el webhook: por eso NO se usa el "link de pago" del dashboard de
   * Wompi, que genera su propia referencia y deja la conciliación a ojo.
   */
  async buildCheckout(input: {
    reference: string;
    amountCOP: number;
    expiresAt?: Date | null;
    customer?: CheckoutCustomer;
  }): Promise<BuiltCheckout> {
    const row = await this.settings.get();
    if (!row.enabled) {
      throw new BadRequestException('La pasarela está apagada');
    }
    if (!row.publicKey || !row.integritySecret) {
      throw new BadRequestException(
        'Faltan la llave pública o el secreto de integridad en Ajustes → Pasarela',
      );
    }

    return buildCheckoutUrl({
      publicKey: row.publicKey,
      integritySecret: row.integritySecret,
      reference: input.reference,
      amountInCents: copToCents(input.amountCOP),
      redirectUrl: row.redirectUrl,
      expiresAt: input.expiresAt,
      customer: input.customer,
    });
  }

  /**
   * Consulta una transacción por id. Es la fuente de verdad: el webhook solo
   * dice "mira esto", y lo que se cree es la respuesta del API. Sin este paso,
   * un evento con checksum robado bastaría para dar un pago por bueno.
   */
  async getTransaction(id: string): Promise<WompiTransactionView | null> {
    const { apiBase, privateKey } = await this.apiContext();
    const res = await this.request(`${apiBase}/transactions/${id}`, {
      Authorization: `Bearer ${privateKey}`,
    });
    if (res.kind === 'network') {
      throw new ServiceUnavailableException(res.detail);
    }
    if (res.status === 404) return null;
    if (res.status !== 200) {
      throw new ServiceUnavailableException(
        `Wompi respondió ${res.status} al consultar la transacción`,
      );
    }
    return readTransaction(readPath(res.body, 'data') ?? res.body);
  }

  /**
   * Busca la transacción de una referencia nuestra. Es lo que permite verificar
   * un cobro a mano cuando el webhook no llegó (o aún no está registrado).
   * Devuelve la aprobada si la hay; si no, la última que exista.
   */
  async findTransactionByReference(
    reference: string,
  ): Promise<WompiTransactionView | null> {
    const { apiBase, privateKey } = await this.apiContext();
    const url = `${apiBase}/transactions?reference=${encodeURIComponent(reference)}`;
    const res = await this.request(url, {
      Authorization: `Bearer ${privateKey}`,
    });
    if (res.kind === 'network') {
      throw new ServiceUnavailableException(res.detail);
    }
    if (res.status !== 200) return null;

    const rows = readPath(res.body, 'data');
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const views = rows.map((row) => readTransaction(row));
    return (
      views.find((t) => t.status === 'APPROVED') ?? views[views.length - 1]
    );
  }

  private async apiContext(): Promise<{ apiBase: string; privateKey: string }> {
    const row = await this.settings.get();
    if (!row.privateKey) {
      throw new BadRequestException(
        'Falta la llave privada en Mensajería → Pasarela',
      );
    }
    const environment: GatewayEnvironment =
      row.environment === 'prod' ? 'prod' : 'test';
    return { apiBase: WOMPI_API_BASE[environment], privateKey: row.privateKey };
  }

  async testConnection(): Promise<ConnectionTest> {
    const row = await this.settings.get();
    const environment: GatewayEnvironment =
      row.environment === 'prod' ? 'prod' : 'test';
    const apiBase = WOMPI_API_BASE[environment];

    const publicResult = await this.checkPublicKey(apiBase, row.publicKey);
    const privateKey = await this.checkPrivateKey(apiBase, row.privateKey);

    return {
      environment,
      apiBase,
      merchantName: publicResult.merchantName,
      publicKey: publicResult.check,
      privateKey,
    };
  }

  /**
   * `GET /merchants/info` con la llave pública en el header. Algunas cuentas
   * responden por la forma vieja `GET /merchants/{publicKey}`, así que si la
   * primera da 404 se reintenta por ahí antes de dar la llave por mala.
   */
  private async checkPublicKey(
    apiBase: string,
    publicKey: string | null,
  ): Promise<{ check: KeyCheck; merchantName: string | null }> {
    if (!publicKey) {
      return {
        check: { ok: null, detail: 'Sin llave pública guardada' },
        merchantName: null,
      };
    }

    const attempts: Array<{ url: string; headers: Record<string, string> }> = [
      {
        url: `${apiBase}/merchants/info`,
        headers: { 'x-merchant-public-key': publicKey },
      },
      { url: `${apiBase}/merchants/${publicKey}`, headers: {} },
    ];

    let last: KeyCheck = { ok: null, detail: 'No se pudo verificar' };
    for (const attempt of attempts) {
      const res = await this.request(attempt.url, attempt.headers);
      if (res.kind === 'network') {
        return { check: { ok: null, detail: res.detail }, merchantName: null };
      }
      if (res.status === 200) {
        const name = readMerchantName(res.body);
        return {
          check: { ok: true, detail: name ? `Comercio: ${name}` : 'Válida' },
          merchantName: name,
        };
      }
      last =
        res.status === 404
          ? { ok: null, detail: 'Endpoint no disponible' }
          : { ok: false, detail: `Wompi respondió ${res.status}` };
      if (res.status !== 404) break;
    }
    return { check: last, merchantName: null };
  }

  /** Lista una transacción con la llave privada: si es inválida, Wompi da 401. */
  private async checkPrivateKey(
    apiBase: string,
    privateKey: string | null,
  ): Promise<KeyCheck> {
    if (!privateKey) return { ok: null, detail: 'Sin llave privada guardada' };

    const res = await this.request(`${apiBase}/transactions?page[size]=1`, {
      Authorization: `Bearer ${privateKey}`,
    });
    if (res.kind === 'network') return { ok: null, detail: res.detail };
    if (res.status === 200) return { ok: true, detail: 'Válida' };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: 'Wompi la rechazó (401/403)' };
    }
    return { ok: null, detail: `Respuesta inesperada (${res.status})` };
  }

  private async request(
    url: string,
    headers: Record<string, string>,
  ): Promise<
    | { kind: 'http'; status: number; body: unknown }
    | { kind: 'network'; detail: string }
  > {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await (res.json() as Promise<unknown>).catch(() => null);
      return { kind: 'http', status: res.status, body };
    } catch (err) {
      const detail = (err as Error).message;
      this.logger.warn(`Wompi no respondió (${url}): ${detail}`);
      return { kind: 'network', detail: `No se pudo contactar a Wompi` };
    }
  }
}

function readMerchantName(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const name = (data as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}
