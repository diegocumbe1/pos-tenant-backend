import { ForbiddenException, Injectable } from '@nestjs/common';
import { PermissionsCacheService } from '../auth/services/permissions-cache.service';
import {
  AuthenticatedUser,
  TenantContext,
} from '../auth/types/tenant-context.interface';
import { PrismaService } from '../prisma/prisma.service';

export interface BusinessRef {
  id: string;
  name: string;
  vertical?: { code: string } | null;
}

export type BusinessResolution =
  | { status: 'resolved'; business: BusinessRef }
  | { status: 'missing'; available: BusinessRef[] }
  | { status: 'unknown'; available: BusinessRef[] }
  | { status: 'ambiguous'; matches: BusinessRef[] };

/** Alexa transcribe distinto cada vez: se compara sin tildes ni puntuación. */
function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * De un nombre hablado al tenant, y del tenant al contexto que esperan los
 * servicios existentes.
 *
 * La lista de negocios sale SIEMPRE de los que el actor tiene autorizados, no
 * de los valores del slot `BUSINESS` del modelo de Alexa. Ese slot solo ayuda
 * al reconocimiento de voz: un tenant que no esté ahí debe seguir siendo
 * accesible, y uno que esté ahí pero no sea del usuario debe ser rechazado.
 */
@Injectable()
export class AssistantScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsCache: PermissionsCacheService,
  ) {}

  async accessibleBusinesses(actor: AuthenticatedUser): Promise<BusinessRef[]> {
    const listed = { deletedAt: null, status: 'ACTIVE' as const };
    const query = {
      select: { id: true, name: true, vertical: { select: { code: true } } },
      orderBy: { name: 'asc' as const },
    };
    const rows = actor.isPlatformAdmin
      ? await this.prisma.tenant.findMany({ where: listed, ...query })
      : // Un admin de plataforma puede no tener tenant propio; un usuario normal
        // sin tenant no tiene nada que consultar.
        actor.tenantId
        ? await this.prisma.tenant.findMany({
            where: { ...listed, id: actor.tenantId },
            ...query,
          })
        : [];
    // El nombre se limpia aquí y no en cada canal: hay tenants guardados con
    // espacios al final ("Bella Chic "), y eso sale a la cara del cliente como
    // "Bella Chic  no registra ventas". Es un dato sucio que no vale la pena
    // migrar, pero tampoco mostrar.
    return rows.map((row) => ({ ...row, name: row.name.trim() }));
  }

  /**
   * @param rememberedId Negocio de la pregunta anterior en esta misma
   * conversación. Se usa solo si no dijeron uno, y se valida igual contra los
   * autorizados: un id recordado no es permiso, es una comodidad.
   */
  async resolveBusiness(
    actor: AuthenticatedUser,
    spoken: string | undefined,
    rememberedId?: string,
  ): Promise<BusinessResolution> {
    const available = await this.accessibleBusinesses(actor);
    if (!spoken?.trim()) {
      const remembered =
        rememberedId && available.find((b) => b.id === rememberedId);
      if (remembered) return { status: 'resolved', business: remembered };
      // Con un solo negocio no hay nada que preguntar, aunque no lo hayan dicho.
      return available.length === 1
        ? { status: 'resolved', business: available[0] }
        : { status: 'missing', available };
    }

    const said = normalize(spoken);
    const exact = available.filter((b) => normalize(b.name) === said);
    if (exact.length === 1) return { status: 'resolved', business: exact[0] };

    // Sin espacios también: el Echo transcribe "Bella Chic" como "bellachi",
    // pegando las palabras y comiéndose el final. Comparar así lo resuelve por
    // prefijo, que con los espacios en medio no coincidiría con nada.
    const tight = said.replace(/\s/g, '');
    const partial = available.filter((b) => {
      const name = normalize(b.name);
      const nameTight = name.replace(/\s/g, '');
      return (
        name.startsWith(said) ||
        said.startsWith(name) ||
        name.includes(said) ||
        nameTight.startsWith(tight) ||
        tight.startsWith(nameTight)
      );
    });
    if (partial.length === 1)
      return { status: 'resolved', business: partial[0] };
    if (partial.length > 1) return { status: 'ambiguous', matches: partial };
    return { status: 'unknown', available };
  }

  /**
   * Sucursales del negocio.
   *
   * Casi todo retail filtra por `ctx.branchId`, así que una consulta de negocio
   * completo se resuelve corriendo la del servicio una vez por sucursal y
   * sumando. Es la única forma de reusar sus reglas sin reescribirlas.
   */
  async branchesOf(tenantId: string): Promise<string[]> {
    const branches = await this.prisma.branch.findMany({
      where: { tenantId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return branches.map((b) => b.id);
  }

  /**
   * Contexto equivalente al que arma `TenantGuard`, para poder reusar los
   * servicios de cada vertical sin duplicar sus reglas.
   *
   * OJO con `branchId`: vacío NO significa "todas las sucursales". Los
   * servicios lo ponen tal cual en el `where`, así que un contexto sin sucursal
   * devuelve cero filas sin error. Solo se deja vacío para métodos que se
   * escribieron explícitamente para todo el tenant.
   */
  async contextFor(
    actor: AuthenticatedUser,
    tenantId: string,
    branchId = '',
  ): Promise<TenantContext> {
    const permissions = actor.isRoot
      ? new Set<string>() // ROOT bypasea checks, igual que en TenantGuard
      : await this.permissionsCache.getForRole(actor.roleId);
    return {
      userId: actor.id,
      email: actor.email,
      name: actor.name,
      tenantId,
      branchId,
      roleId: actor.roleId,
      roleCode: actor.roleCode,
      isRoot: actor.isRoot,
      permissions,
      accessibleBranches: actor.accessibleBranches,
    };
  }

  /** Misma regla que `@RequirePermissions` en los controladores. */
  assertPermission(ctx: TenantContext, code: string): void {
    if (ctx.isRoot || ctx.permissions.has(code)) return;
    throw new ForbiddenException(`Missing permission: ${code}`);
  }
}
