import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Session, User as SupabaseUser } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { AdminService } from '../../admin/admin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseService } from '../../supabase/supabase.service';
import {
  AcceptInviteDto,
  InviteUserDto,
  SignupInviteDto,
} from '../dto/invite-user.dto';
import { LoginDto } from '../dto/login.dto';
import { RecoverPasswordDto } from '../dto/recover-password.dto';
import { ResendInvitationDto } from '../dto/resend-invitation.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';
import {
  defaultMenuTheme,
  elapsedMs,
  isMenuSlugReserved,
  normalizeVertical,
  slugify,
} from '../helpers/auth-helpers';
import { SupabaseJwtPayload } from '../types/jwt-payload.interface';
import { AuthenticatedUser } from '../types/tenant-context.interface';
import { resolveEffectiveFeatures } from '../../platform/plans/plan-features';
import { PermissionsCacheService } from './permissions-cache.service';

// Estados de suscripción que permiten operar la app del tenant (§10.5).
const ACTIVE_SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

type LoginProfileRow = {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  isPlatformAdmin: boolean;
  passwordSetAt: Date | null;
  tenantId: string | null;
  tenant: {
    id: string;
    name: string;
    documentId?: string | null;
    plan: string;
    status: string;
    featureOverrides: Record<string, boolean | number> | null;
    subscriptionStatus: string | null;
    vertical?: { code: string } | null;
  } | null;
  role: {
    id: string;
    code: string;
    name: string;
    isSystem: boolean;
  } | null;
  userBranches: Array<{
    branch: { id: string; name: string; tenantId: string };
  }>;
};

type BranchProfile = {
  id: string;
  name: string;
  tenantId: string;
  isActive: boolean;
};

type TenantProfile = {
  id: string;
  name: string;
  documentId?: string | null;
  slug: string;
  vertical: string | null;
  plan: string;
};

type AuthProfile = {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  isPlatformAdmin: boolean;
  passwordSet: boolean;
  tenant: TenantProfile | null;
  features: Record<string, boolean | number> | null;
  role: LoginProfileRow['role'];
  isRoot: boolean;
  permissions: string[];
  branches: BranchProfile[];
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly permissionsCache: PermissionsCacheService,
    private readonly adminService: AdminService,
  ) {}

  async inviteUser(dto: InviteUserDto) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: dto.tenantId },
      select: { id: true, name: true },
    });

    if (!tenant) {
      throw new BadRequestException('Tenant not found');
    }

    const role = await this.prisma.role.findFirst({
      where: {
        code: dto.roleCode,
        OR: [{ tenantId: dto.tenantId }, { isSystem: true }],
      },
      select: {
        id: true,
        code: true,
        name: true,
        tenantId: true,
        isSystem: true,
      },
    });

    if (!role) {
      throw new BadRequestException('Role not found for tenant');
    }

    const existingUser = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { name: dto.name }] },
      select: { id: true, email: true },
    });

    if (existingUser) {
      throw new BadRequestException('User already exists');
    }

    const redirectTo = this.supabase.inviteRedirectUrl;

    await this.supabase.inviteUserByEmail(dto.email, {
      redirectTo,
      data: {
        name: dto.name,
        tenantId: dto.tenantId,
        roleCode: dto.roleCode,
      },
    });

    return {
      ok: true,
      message: 'Invitation sent successfully',
      email: dto.email,
      tenant,
      role,
      redirectTo,
    };
  }

  async signupInvite(dto: SignupInviteDto) {
    const email = dto.email.trim().toLowerCase();
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingUser) {
      throw new ConflictException('User already exists');
    }

    const verticalCode = normalizeVertical(dto.vertical);
    const planCode = dto.plan ?? 'BASIC';

    const vertical = await this.prisma.businessVertical.findUnique({
      where: { code: verticalCode },
      include: {
        plans: {
          where: {
            isActive: true,
            plan: { code: planCode, isActive: true },
          },
          include: { plan: true },
        },
      },
    });

    if (!vertical || !vertical.isActive) {
      throw new BadRequestException(`Vertical not available: ${dto.vertical}`);
    }

    const selectedPlan = vertical.plans[0]?.plan;
    if (!selectedPlan) {
      throw new BadRequestException(
        `Plan ${planCode} is not available for vertical ${verticalCode}`,
      );
    }

    const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
    const branchId = `branch-${randomUUID().slice(0, 8)}`;
    const businessName =
      dto.businessName?.trim() || `Negocio de ${dto.name.trim()}`;
    const branchName = dto.branchName?.trim() || 'Sucursal Principal';
    const menuSlug = await this.nextAvailableMenuSlug(slugify(businessName));

    const tenant = await this.prisma.$transaction(async (tx) => {
      const createdTenant = await tx.tenant.create({
        data: {
          id: tenantId,
          name: businessName,
          plan: selectedPlan.code,
          verticalId: vertical.id,
          planId: selectedPlan.id,
        },
      });

      await tx.branch.create({
        data: { id: branchId, tenantId, name: branchName },
      });

      // Todo tenant nace con suscripción (TRIALING, 1 mes): sin ella el
      // backoffice mostraba la cuenta como "sin suscripción registrada" aunque
      // ya tuviera pagos.
      const periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + 1);
      await tx.subscription.create({
        data: {
          tenantId,
          plan: selectedPlan.code,
          status: 'TRIALING',
          billingCycle: 'monthly',
          currentPeriodStart: new Date(),
          currentPeriodEnd: periodEnd,
          trialEndsAt: periodEnd,
          priceCOP: selectedPlan.priceCOP || undefined,
          provider: 'manual',
        },
      });

      await tx.menuPublicConfig.create({
        data: {
          tenantId,
          branchId,
          slug: menuSlug,
          isPublished: false,
          showPrices: true,
          showDescription: true,
          showImages: true,
          showUnavailable: false,
          showFeaturedBadge: true,
          showRatings: false,
          showSavedCount: false,
          featuredProductIds: [],
          categoryOrder: [],
          ...defaultMenuTheme(businessName),
        },
      });

      return createdTenant;
    });

    await this.adminService.seedSystemRolesForTenant(tenantId);

    const ownerRole = await this.prisma.role.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: 'OWNER' } },
      select: { id: true, code: true, name: true },
    });

    const redirectTo = this.supabase.inviteRedirectUrl;
    const supabaseUser = await this.supabase.inviteUserByEmail(email, {
      redirectTo,
      data: {
        name: dto.name,
        tenantId,
        branchId,
        roleCode: 'OWNER',
        roleId: ownerRole.id,
        vertical: vertical.code,
        plan: selectedPlan.code,
      },
    });

    await this.prisma.user.create({
      data: {
        id: supabaseUser.id,
        tenantId,
        email,
        name: dto.name,
        roleId: ownerRole.id,
        invitedAt: new Date(),
        userBranches: { create: [{ branchId }] },
      },
    });

    return {
      ok: true,
      message: 'Signup invitation sent successfully',
      email,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        vertical: vertical.code,
        plan: selectedPlan.code,
        menuSlug,
      },
      branch: { id: branchId, name: branchName },
      owner: {
        id: supabaseUser.id,
        email,
        role: ownerRole.code,
        status: 'INVITED',
      },
      redirectTo,
    };
  }

  async getCurrentProfile(
    authUser: AuthenticatedUser,
    timings: Record<string, number> = {},
  ) {
    const profileStart = performance.now();
    const user = await this.loadLoginProfile(authUser.id);
    timings.profile = elapsedMs(profileStart);

    if (!user) throw new UnauthorizedException('User not found');
    if (!user.role) throw new UnauthorizedException('User role not found');

    this.assertTenantAccess(user, authUser.isRoot);

    const permissionsStart = performance.now();
    const permissions = authUser.isRoot
      ? null
      : await this.permissionsCache.getForRole(authUser.roleId);
    timings.permissions = elapsedMs(permissionsStart);

    const branchesStart = performance.now();
    const branches = await this.resolveAccessibleBranches(user);
    timings.branches = elapsedMs(branchesStart);

    return this.toAuthProfile(user, authUser.isRoot, permissions, branches);
  }

  async login(dto: LoginDto, timings: Record<string, number> = {}) {
    const authStart = performance.now();
    let session;
    let authUser;
    try {
      ({ session, user: authUser } = await this.supabase.signInWithPassword(
        dto.email,
        dto.password,
      ));
    } catch (err) {
      // Si el login falla, distinguimos un usuario invitado que aún no activó
      // su cuenta (no fijó contraseña) para dar un mensaje claro.
      await this.assertNotPendingInvitation(dto.email);
      throw err;
    }
    timings.auth = elapsedMs(authStart);

    const response = await this.buildLoginResponse(
      authUser.id,
      session,
      authUser,
      timings,
    );

    this.logger.log(
      `login email=${dto.email} userId=${authUser.id} auth=${timings.auth.toFixed(1)}ms`,
    );

    return response;
  }

  /**
   * Lanza un 401 con mensaje claro si el email pertenece a un usuario invitado
   * que todavía no activó su cuenta (sin contraseña fijada). Solo aplica a
   * usuarios nuevos: si ya activó su clave, dejamos pasar el error original.
   */
  private async assertNotPendingInvitation(email: string) {
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email.trim(), mode: 'insensitive' } },
      select: { invitedAt: true, passwordSetAt: true },
    });

    if (user && user.invitedAt && !user.passwordSetAt) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'Unauthorized',
        code: 'INVITATION_PENDING',
        message:
          'Tu cuenta aún no está activada. Revisa tu correo para aceptar la invitación y crear tu contraseña.',
      });
    }
  }

  async recoverPassword(dto: RecoverPasswordDto) {
    const redirectTo = this.supabase.recoveryRedirectUrl;
    await this.supabase.sendPasswordRecoveryEmail(dto.email, redirectTo);
    return {
      ok: true,
      message: 'Password recovery email sent successfully',
      email: dto.email,
      redirectTo,
    };
  }

  /**
   * Reenvía el correo de acceso a un usuario invitado que aún no activó su
   * cuenta. No se puede reusar `inviteUserByEmail` porque Supabase rechaza
   * usuarios existentes; en su lugar reenviamos el email de "set password"
   * (Supabase lo envía vía SMTP). El link lleva a `recoveryRedirectUrl`, y
   * `resetPassword` provisiona/activa al usuario local.
   */
  async resendInvitation(dto: ResendInvitationDto) {
    const email = dto.email.trim().toLowerCase();

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { passwordSetAt: true },
    });

    if (user?.passwordSetAt) {
      throw new BadRequestException({
        code: 'ALREADY_ACTIVATED',
        message:
          'Esta cuenta ya está activada. Usa "Iniciar sesión" o "¿Olvidaste tu contraseña?".',
      });
    }

    const redirectTo = this.supabase.recoveryRedirectUrl;
    // Supabase responde OK aunque el correo no exista (evita enumeración),
    // por eso devolvemos un mensaje neutro al frontend.
    await this.supabase.sendPasswordRecoveryEmail(email, redirectTo);

    return {
      ok: true,
      message: 'Invitation email resent successfully',
      email,
      redirectTo,
    };
  }

  async resetPassword(
    authUser: AuthenticatedUser | undefined,
    authPayload: SupabaseJwtPayload | undefined,
    dto: ResetPasswordDto,
  ) {
    const userId = authUser?.id ?? authPayload?.sub;
    if (!userId) {
      throw new UnauthorizedException('Missing authenticated user in request');
    }

    // Si el correo se reenvió como "set password" a un invitado que aún no
    // tenía usuario local (flujo staff de `inviteUser`), lo provisionamos aquí
    // a partir del metadata del token. Best-effort: un reset normal (usuario ya
    // existente) no debe verse afectado si esto falla.
    try {
      await this.ensureLocalUserForInvitation(userId, authUser, authPayload);
    } catch (err) {
      this.logger.warn(
        `resetPassword: no se pudo provisionar usuario local ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await this.supabase.setPassword(userId, dto.newPassword);
    await this.prisma.user.updateMany({
      where: { id: userId, passwordSetAt: null },
      data: { passwordSetAt: new Date() },
    });

    return { ok: true, userId };
  }

  async acceptInvite(
    authUser: AuthenticatedUser | undefined,
    authPayload: SupabaseJwtPayload | undefined,
    dto: AcceptInviteDto,
  ) {
    const userId = authUser?.id ?? authPayload?.sub;
    if (!userId) {
      throw new UnauthorizedException('Missing authenticated user in request');
    }
    if (authUser?.passwordSetAt) {
      throw new BadRequestException('Password already set');
    }

    const user = await this.ensureLocalUserForInvitation(
      userId,
      authUser,
      authPayload,
    );
    if (user.passwordSetAt) {
      throw new BadRequestException('Password already set');
    }

    await this.supabase.setPassword(user.id, dto.password);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordSetAt: new Date() },
    });

    const { session, user: sessionUser } =
      await this.supabase.signInWithPassword(user.email, dto.password);

    return this.buildLoginResponse(user.id, session, sessionUser);
  }

  private async buildLoginResponse(
    userId: string,
    session: Session,
    authUser: SupabaseUser,
    timings: Record<string, number> = {},
  ) {
    const profileStart = performance.now();
    const user = await this.loadLoginProfile(userId);
    timings.profile = elapsedMs(profileStart);

    if (!user) {
      throw new UnauthorizedException(
        'User not provisioned — complete invitation flow',
      );
    }
    if (!user.role) {
      throw new UnauthorizedException('User role not found');
    }

    const isRoot = user.role.code === 'ROOT';
    this.assertTenantAccess(user, isRoot);

    const branchesStart = performance.now();
    const branches = await this.resolveAccessibleBranches(user);
    timings.branches = elapsedMs(branchesStart);

    const permissionsStart = performance.now();
    const permissions = isRoot
      ? null
      : await this.permissionsCache.getForRole(user.role.id);
    timings.permissions = elapsedMs(permissionsStart);

    return {
      ok: true,
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      expires_in: session.expires_in,
      token_type: session.token_type,
      user: { id: authUser.id, email: authUser.email },
      profile: this.toAuthProfile(user, isRoot, permissions, branches),
    };
  }

  /**
   * Enforcement de acceso por suscripción (§10.5). Corta el login/sesión de un
   * usuario de tenant cuando su cuenta o suscripción no está activa, o el usuario
   * fue deshabilitado. Platform admins y ROOT nunca quedan bloqueados.
   */
  private assertTenantAccess(
    user: Pick<LoginProfileRow, 'isActive' | 'isPlatformAdmin' | 'tenant'>,
    isRoot = false,
  ): void {
    if (user.isPlatformAdmin || isRoot) return;

    if (!user.isActive) {
      throw new ForbiddenException({
        code: 'USER_DISABLED',
        message: 'Tu usuario fue deshabilitado. Contacta al administrador.',
      });
    }

    const tenant = user.tenant;
    if (!tenant) return; // sin tenant (no debería para non-root) → no bloquear aquí

    const tenantActive = tenant.status === 'ACTIVE';
    const subOk = ACTIVE_SUBSCRIPTION_STATUSES.includes(
      tenant.subscriptionStatus ?? 'ACTIVE',
    );
    if (!tenantActive || !subOk) {
      throw new ForbiddenException({
        code: 'ACCOUNT_INACTIVE',
        message: 'La cuenta no está activa. Contacta a soporte.',
        tenantStatus: tenant.status,
        subscriptionStatus: tenant.subscriptionStatus,
      });
    }
  }

  /** Features efectivos del tenant (PLAN_FEATURES[plan] + featureOverrides). */
  private resolveTenantFeatures(
    tenant: LoginProfileRow['tenant'],
  ): Record<string, boolean | number> | null {
    if (!tenant) return null;
    return resolveEffectiveFeatures(tenant.plan, tenant.featureOverrides);
  }

  private toAuthProfile(
    user: LoginProfileRow,
    isRoot: boolean,
    permissions: Set<string> | null,
    branches: BranchProfile[],
  ): AuthProfile {
    const isPlatformAdmin = user.isPlatformAdmin || isRoot;
    const platformOnly = isPlatformAdmin && !user.tenant;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      isActive: user.isActive,
      isPlatformAdmin,
      passwordSet: !!user.passwordSetAt,
      tenant: platformOnly
        ? this.platformTenantProfile()
        : this.toTenantProfile(user.tenant),
      features: platformOnly
        ? resolveEffectiveFeatures('PREMIUM')
        : this.resolveTenantFeatures(user.tenant),
      role: user.role,
      isRoot,
      permissions: isRoot ? ['*'] : [...(permissions ?? new Set<string>())],
      branches,
    };
  }

  private platformTenantProfile(): TenantProfile {
    return {
      id: 'platform',
      name: 'Lynko Platform',
      slug: 'platform',
      vertical: 'platform',
      plan: 'PREMIUM',
    };
  }

  private async loadLoginProfile(
    userId: string,
  ): Promise<LoginProfileRow | null> {
    const rows = await this.prisma.$queryRaw<LoginProfileRow[]>`
      SELECT
        u.id,
        u.email,
        u.name,
        u."isActive",
        u."isPlatformAdmin",
        u."passwordSetAt",
        u."tenantId",
        CASE
          WHEN t.id IS NULL THEN NULL
          ELSE json_build_object(
            'id', t.id,
            'name', t.name,
            'documentId', t."documentId",
            'plan', t.plan,
            'status', t.status,
            'featureOverrides', t."featureOverrides",
            'subscriptionStatus', s.status,
            'vertical', CASE
              WHEN v.id IS NULL THEN NULL
              ELSE json_build_object('code', v.code)
            END
          )
        END AS tenant,
        CASE
          WHEN r.id IS NULL THEN NULL
          ELSE json_build_object(
            'id', r.id,
            'code', r.code,
            'name', r.name,
            'isSystem', r."isSystem"
          )
        END AS role,
        COALESCE(
          json_agg(
            json_build_object(
              'branch',
              json_build_object('id', b.id, 'name', b.name, 'tenantId', b."tenantId")
            )
          ) FILTER (WHERE b.id IS NOT NULL),
          '[]'::json
        ) AS "userBranches"
      FROM users u
      LEFT JOIN tenants t ON t.id = u."tenantId"
      LEFT JOIN business_verticals v ON v.id = t."verticalId"
      LEFT JOIN subscriptions s ON s."tenantId" = t.id
      LEFT JOIN roles r ON r.id = u."roleId"
      LEFT JOIN user_branches ub ON ub."userId" = u.id
      LEFT JOIN branches b ON b.id = ub."branchId"
      WHERE u.id = ${userId}
      GROUP BY u.id, t.id, v.id, s.id, r.id
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  private async resolveAccessibleBranches(user: {
    tenantId: string | null;
    role: { code: string } | null;
    userBranches: Array<{
      branch: { id: string; name: string; tenantId: string };
    }>;
  }): Promise<BranchProfile[]> {
    const assignedBranches = user.userBranches.map((ub) =>
      this.toBranchProfile(ub.branch),
    );

    if (
      assignedBranches.length > 0 ||
      !user.tenantId ||
      !user.role ||
      user.role.code !== 'OWNER'
    ) {
      return assignedBranches;
    }

    const tenantBranches = await this.prisma.branch.findMany({
      where: { tenantId: user.tenantId },
      select: { id: true, name: true, tenantId: true },
      orderBy: { createdAt: 'asc' },
    });
    return tenantBranches.map((branch) => this.toBranchProfile(branch));
  }

  private toTenantProfile(
    tenant: {
      id: string;
      name: string;
      documentId?: string | null;
      plan: string;
      vertical?: { code: string } | null;
    } | null,
  ): TenantProfile | null {
    if (!tenant) return null;
    return {
      id: tenant.id,
      name: tenant.name,
      documentId: tenant.documentId ?? null,
      slug: slugify(tenant.name),
      vertical: tenant.vertical?.code ?? null,
      plan: tenant.plan,
    };
  }

  private toBranchProfile(branch: {
    id: string;
    name: string;
    tenantId: string;
  }): BranchProfile {
    return { ...branch, isActive: true };
  }

  private async ensureLocalUserForInvitation(
    userId: string,
    authUser?: AuthenticatedUser,
    authPayload?: SupabaseJwtPayload,
  ) {
    const existingUser = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        role: true,
        userBranches: { select: { branchId: true } },
      },
    });
    if (existingUser) return existingUser;

    if (!authPayload?.email) {
      throw new UnauthorizedException('Missing email in token payload');
    }

    const metadata = {
      ...(authPayload.app_metadata ?? {}),
      ...(authPayload.user_metadata ?? {}),
    } as Record<string, unknown>;

    const tenantId = String(metadata.tenantId ?? '');
    const roleCode = String(metadata.roleCode ?? '');
    const branchId = String(metadata.branchId ?? '');
    const name = String(
      metadata.name ?? authPayload.email.split('@')[0] ?? 'User',
    );

    if (!tenantId) {
      throw new UnauthorizedException('Missing tenantId in token metadata');
    }
    if (!roleCode) {
      throw new UnauthorizedException('Missing roleCode in token metadata');
    }

    const [tenant, role] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true },
      }),
      this.prisma.role.findFirst({
        where: {
          code: roleCode,
          OR: [{ tenantId }, { isSystem: true }],
        },
        select: { id: true, code: true },
      }),
    ]);

    if (!tenant) {
      throw new UnauthorizedException(
        'Tenant from token metadata was not found',
      );
    }
    if (!role) {
      throw new UnauthorizedException('Role from token metadata was not found');
    }

    return this.prisma.user.create({
      data: {
        id: userId,
        email: authPayload.email,
        name,
        tenantId: tenant.id,
        roleId: role.id,
        isActive: true,
        passwordSetAt: authUser?.passwordSetAt ?? null,
        userBranches: branchId ? { create: [{ branchId }] } : undefined,
      },
      include: {
        role: true,
        userBranches: { select: { branchId: true } },
      },
    });
  }

  private async nextAvailableMenuSlug(baseSlug: string): Promise<string> {
    const base = baseSlug || 'menu';
    for (let index = 0; index < 100; index += 1) {
      const slug = index === 0 ? base : `${base}-${index + 1}`;
      if (isMenuSlugReserved(slug)) continue;

      const existing = await this.prisma.menuPublicConfig.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (!existing) return slug;
    }
    throw new ConflictException('Could not generate available menu slug');
  }
}
