import { Injectable } from '@nestjs/common';
import { PlatformGatewaySettings } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateGatewaySettingsDto } from '../dto/platform-gateway.dto';
import {
  GATEWAY_SINGLETON_ID,
  GATEWAY_WEBHOOK_PATH,
  GatewayEnvironment,
  GatewayMethod,
  WOMPI_API_BASE,
  WOMPI_KEY_PREFIX,
} from '../platform-gateway.constants';

/** Lo que ve la consola: la fila sin los tres secretos en claro. */
export interface PublicGatewaySettings {
  id: string;
  provider: string;
  enabled: boolean;
  environment: GatewayEnvironment;
  publicKey: string | null;
  enabledMethods: GatewayMethod[];
  redirectUrl: string | null;
  updatedAt: Date;

  hasPrivateKey: boolean;
  hasEventsSecret: boolean;
  hasIntegritySecret: boolean;
  /** Últimos 4 caracteres, para reconocer cuál está puesta sin exponerla. */
  privateKeyHint: string | null;
  eventsSecretHint: string | null;
  integritySecretHint: string | null;

  /** Base del API de Wompi para el ambiente elegido. */
  apiBase: string;
  /**
   * URL que hay que pegar en "URL de Eventos" del dashboard de Wompi. Si el
   * backend no sabe su propia URL pública (`PUBLIC_API_URL`), devuelve solo la
   * ruta para que la consola muestre el hueco en vez de inventarse un dominio.
   */
  webhookUrl: string;
  /** Llaves cuyo prefijo no corresponde al ambiente elegido. */
  keyMismatches: string[];
  /** Qué falta para poder cobrar. Vacío = listo. */
  missing: string[];
}

@Injectable()
export class GatewaySettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Fila única con los secretos. Solo para uso interno (checkout y webhook). */
  get(): Promise<PlatformGatewaySettings> {
    return this.prisma.platformGatewaySettings.upsert({
      where: { id: GATEWAY_SINGLETON_ID },
      update: {},
      create: { id: GATEWAY_SINGLETON_ID },
    });
  }

  /** Versión para la API: nunca devuelve llave privada ni secretos. */
  async getPublic(): Promise<PublicGatewaySettings> {
    const row = await this.get();
    const environment = this.env(row.environment);
    const prefixes = WOMPI_KEY_PREFIX[environment];

    // Cruzar llaves de sandbox con la URL de producción (o al revés) declina
    // todas las transacciones sin decir por qué, así que se avisa aquí.
    const keyMismatches: string[] = [];
    const check = (
      label: string,
      value: string | null,
      expected: string,
    ): void => {
      if (value && !value.startsWith(expected)) keyMismatches.push(label);
    };
    check('Llave pública', row.publicKey, prefixes.publicKey);
    check('Llave privada', row.privateKey, prefixes.privateKey);
    check('Secreto de eventos', row.eventsSecret, prefixes.eventsSecret);
    check(
      'Secreto de integridad',
      row.integritySecret,
      prefixes.integritySecret,
    );

    const missing: string[] = [];
    if (!row.publicKey) missing.push('Llave pública');
    if (!row.privateKey) missing.push('Llave privada');
    if (!row.eventsSecret) missing.push('Secreto de eventos');
    if (!row.integritySecret) missing.push('Secreto de integridad');

    return {
      id: row.id,
      provider: row.provider,
      enabled: row.enabled,
      environment,
      publicKey: row.publicKey,
      enabledMethods: this.methods(row.enabledMethods),
      redirectUrl: row.redirectUrl,
      updatedAt: row.updatedAt,

      hasPrivateKey: !!row.privateKey,
      hasEventsSecret: !!row.eventsSecret,
      hasIntegritySecret: !!row.integritySecret,
      privateKeyHint: hint(row.privateKey),
      eventsSecretHint: hint(row.eventsSecret),
      integritySecretHint: hint(row.integritySecret),

      apiBase: WOMPI_API_BASE[environment],
      webhookUrl: this.webhookUrl(),
      keyMismatches,
      missing,
    };
  }

  async update(dto: UpdateGatewaySettingsDto): Promise<PublicGatewaySettings> {
    await this.get();

    const {
      privateKey,
      eventsSecret,
      integritySecret,
      clearPrivateKey,
      clearEventsSecret,
      clearIntegritySecret,
      ...rest
    } = dto;

    // Misma convención que la API key de Resend: la UI no puede mostrar el
    // secreto guardado, así que manda el campo vacío cuando no lo cambia. Vacío
    // significa "déjalo como está", no "bórralo".
    const secrets = {
      ...patch('privateKey', privateKey, clearPrivateKey),
      ...patch('eventsSecret', eventsSecret, clearEventsSecret),
      ...patch('integritySecret', integritySecret, clearIntegritySecret),
    };

    await this.prisma.platformGatewaySettings.update({
      where: { id: GATEWAY_SINGLETON_ID },
      data: { ...rest, ...secrets },
    });
    return this.getPublic();
  }

  private env(value: string): GatewayEnvironment {
    return value === 'prod' ? 'prod' : 'test';
  }

  private methods(value: unknown): GatewayMethod[] {
    if (!Array.isArray(value)) return ['CARD'];
    return value.filter((m): m is GatewayMethod => m === 'CARD' || m === 'PSE');
  }

  private webhookUrl(): string {
    const base = process.env.PUBLIC_API_URL?.replace(/\/+$/, '');
    return base ? `${base}${GATEWAY_WEBHOOK_PATH}` : GATEWAY_WEBHOOK_PATH;
  }
}

function hint(value: string | null): string | null {
  return value ? value.slice(-4) : null;
}

function patch(
  field: 'privateKey' | 'eventsSecret' | 'integritySecret',
  value: string | undefined,
  clear: boolean | undefined,
): Record<string, string | null> {
  if (clear === true) return { [field]: null };
  const trimmed = value?.trim();
  return trimmed ? { [field]: trimmed } : {};
}
