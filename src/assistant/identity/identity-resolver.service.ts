import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { normalizePhone } from '../../platform-messaging/phone.util';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Qué es el número para Lynko: o una cuenta, o nadie.
 *
 * No hay estados intermedios a propósito. Un número que aparece en un contacto
 * de cobro o en la lista de clientes de un negocio NO es una identidad para
 * este agente: no puede consultar nada, así que tratarlo distinto solo serviría
 * para revelar que lo conocemos.
 */
export type IdentityKind = 'USER' | 'UNKNOWN';

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

  /**
   * Ids de usuarios cuyo teléfono, sin puntuación, coincide con el que escribe.
   *
   * Se compara normalizado EN SQL para no traer la tabla entera solo para
   * limpiar dígitos. La consulta es literal salvo los dos parámetros, y esos
   * salen del identificador de WhatsApp, nunca del texto del mensaje.
   *
   * Solo consulta `users`: es la única tabla cuyo teléfono corresponde a una
   * cuenta con rol y permisos.
   */
  private async matchingUserIds(variants: [string, string]): Promise<string[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "users"
        WHERE regexp_replace(coalesce("phone", ''), '\\D', '', 'g') IN ($1, $2)
        LIMIT 20`,
      variants[0],
      variants[1],
    );
    return rows.map((r) => r.id);
  }

  async resolveByPhone(phone: string): Promise<ResolvedIdentity> {
    const variants = this.digitVariants(phone);
    if (!variants) return UNKNOWN;

    const userIds = await this.matchingUserIds(variants);
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

    // Sin cuenta de Lynko, desconocido. Punto.
    //
    // Antes se buscaba también en contactos de cobro y en los clientes de cada
    // negocio, solo para poder saludar por el nombre. Se quitó a propósito: ese
    // nombre no es de quien escribe, es de una fila que COINCIDE con su número.
    // Saludar con él le confirma a cualquiera que tenga ese teléfono —o que lo
    // herede, o que se lo robe— que Lynko tiene datos suyos, y no aporta nada a
    // cambio: esa persona no puede consultar nada igual.
    //
    // Los nombres de clientes, además, son de los NEGOCIOS, no de la
    // plataforma. Leerlos para redactar un saludo del número de Lynko es usar
    // datos de un tenant para otra cosa.
    return UNKNOWN;
  }
}
