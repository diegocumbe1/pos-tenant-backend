import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { normalizePhone } from '../../platform-messaging/phone.util';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Qué es el número para Lynko.
 *
 * El orden importa: `USER` es el único que trae permisos. Los demás sirven para
 * saludar por el nombre y para no tratar a un cliente conocido como a un
 * desconocido, pero NO autorizan ninguna consulta.
 */
export type IdentityKind = 'USER' | 'BILLING_CONTACT' | 'CUSTOMER' | 'UNKNOWN';

export interface IdentityActor {
  actor: AuthenticatedUser;
  /** El tenant al que pertenece ESTA cuenta. Puede no ser el único accesible. */
  tenantId: string | null;
}

export interface ResolvedIdentity {
  known: boolean;
  kind: IdentityKind;
  /** Primer nombre, para saludar. Null cuando no se sabe quién es. */
  firstName: string | null;
  /**
   * Cuentas de Lynko que responden a este número, cada una con su propio rol.
   *
   * Es una lista y no una persona porque `User` pertenece a UN tenant: quien
   * tiene dos negocios tiene dos cuentas. Los negocios que puede consultar cada
   * una salen después de `AssistantScopeService.accessibleBusinesses`, nunca de
   * aquí.
   */
  actors: IdentityActor[];
}

const UNKNOWN: ResolvedIdentity = {
  known: false,
  kind: 'UNKNOWN',
  firstName: null,
  actors: [],
};

function firstNameOf(full: string | null | undefined): string | null {
  const first = full?.trim().split(/\s+/)[0];
  return first ? first : null;
}

/**
 * De un teléfono a quién es en Lynko.
 *
 * Vive en `assistant/` y no en `whatsapp/` porque la pregunta "¿quién es este
 * número?" no es de WhatsApp: mañana sirve igual para un SMS, para el chat web
 * de un cliente, o para identificar a quien llama.
 *
 * REGLA: resolver la identidad NO autoriza nada. Lo único que decide esta clase
 * es con QUÉ permisos se va a trabajar; qué puede consultar esa cuenta lo
 * siguen decidiendo `accessibleBusinesses` y `assertPermission`.
 */
@Injectable()
export class IdentityResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Las formas en que el mismo celular puede estar guardado.
   *
   * Se comparan solo dígitos: en la base hay números con indicativo, sin él, con
   * espacios y con `+`. Exigir un formato sería garantizar que la mitad no
   * resuelva.
   */
  private digitVariants(raw: string): [string, string] | null {
    let full: string;
    try {
      full = normalizePhone(raw);
    } catch {
      return null;
    }
    // Siempre DOS, aunque sean iguales: así la consulta lleva un número fijo de
    // parámetros y no hay que pasarle un arreglo a Postgres.
    // Colombia: 57 + 10 dígitos. El nacional suelto es como lo teclea casi todo
    // el mundo al crear un usuario.
    const national =
      full.length === 12 && full.startsWith('57') ? full.slice(2) : full;
    return [full, national];
  }

  /** Ids de filas cuyo teléfono, sin puntuación, coincide con alguna variante. */
  private async matchingIds(
    table:
      | 'users'
      | 'billing_contacts'
      | 'retail_customers'
      | 'barber_customers',
    columns: string[],
    variants: [string, string],
  ): Promise<string[]> {
    // Se normaliza en SQL (no en TypeScript) para no traer la tabla entera solo
    // para comparar dígitos. La lista de tablas y columnas es literal y cerrada:
    // nada de esto viene del mensaje del usuario, que nunca toca esta consulta.
    const where = columns
      .map(
        (c) =>
          `regexp_replace(coalesce("${c}", ''), '\\D', '', 'g') IN ($1, $2)`,
      )
      .join(' OR ');
    const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "${table}" WHERE ${where} LIMIT 20`,
      variants[0],
      variants[1],
    );
    return rows.map((r) => r.id);
  }

  async resolveByPhone(phone: string): Promise<ResolvedIdentity> {
    const variants = this.digitVariants(phone);
    if (!variants) return UNKNOWN;

    const userIds = await this.matchingIds('users', ['phone'], variants);
    if (userIds.length) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: userIds }, isActive: true },
        include: { role: true, userBranches: true },
        orderBy: { createdAt: 'asc' },
      });
      // Misma regla que el resto del backend: sin contraseña puesta, la cuenta
      // todavía no está provisionada y no responde por ella nadie.
      const usable = users.filter(
        (u) => u.passwordSetAt || u.role.code === 'ROOT',
      );
      if (usable.length) {
        return {
          known: true,
          kind: 'USER',
          firstName: firstNameOf(usable[0].name),
          actors: usable.map((user) => ({
            tenantId: user.tenantId,
            actor: {
              id: user.id,
              email: user.email,
              name: user.name,
              tenantId: user.tenantId,
              roleId: user.roleId,
              roleCode: user.role.code,
              isRoot: user.role.code === 'ROOT',
              isPlatformAdmin:
                user.isPlatformAdmin || user.role.code === 'ROOT',
              passwordSetAt: user.passwordSetAt,
              accessibleBranches: user.userBranches.map((b) => b.branchId),
            },
          })),
        };
      }
    }

    // Sin cuenta. Se sigue buscando SOLO para saber cómo llamar a la persona y
    // para no darle el discurso comercial a un cliente de un negocio nuestro.
    // Ninguna de estas filas otorga acceso a nada, y el NEGOCIO al que
    // pertenecen no se nombra nunca: sería enumerar tenants.
    const contactIds = await this.matchingIds(
      'billing_contacts',
      ['phone', 'whatsapp'],
      variants,
    );
    if (contactIds.length) {
      const contact = await this.prisma.billingContact.findFirst({
        where: { id: { in: contactIds } },
        select: { name: true },
      });
      return {
        known: true,
        kind: 'BILLING_CONTACT',
        firstName: firstNameOf(contact?.name),
        actors: [],
      };
    }

    const [retailIds, barberIds] = await Promise.all([
      this.matchingIds('retail_customers', ['phone'], variants),
      this.matchingIds('barber_customers', ['phone'], variants),
    ]);
    if (retailIds.length || barberIds.length) {
      const name = retailIds.length
        ? (
            await this.prisma.retailCustomer.findFirst({
              where: { id: { in: retailIds }, deletedAt: null },
              select: { name: true },
            })
          )?.name
        : (
            await this.prisma.barberCustomer.findFirst({
              where: { id: { in: barberIds } },
              select: { name: true },
            })
          )?.name;
      return {
        known: true,
        kind: 'CUSTOMER',
        firstName: firstNameOf(name),
        actors: [],
      };
    }

    return UNKNOWN;
  }
}
