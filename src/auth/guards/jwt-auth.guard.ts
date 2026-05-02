import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { performance } from 'perf_hooks';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseJwtPayload } from '../types/jwt-payload.interface';
import { AuthenticatedUser } from '../types/tenant-context.interface';

type TimedRequest = Request & {
  requestTimings?: Record<string, number>;
  authPayload?: SupabaseJwtPayload;
  user?: AuthenticatedUser;
};

type CachedAuthUser = {
  user: AuthenticatedUser;
  expiresAt: number;
};

const AUTH_USER_CACHE_TTL_MS = 30_000;

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private readonly issuer: string;
  private readonly audience = 'authenticated';
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly userCache = new Map<string, CachedAuthUser>();
  private readonly userLoads = new Map<string, Promise<AuthenticatedUser>>();

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const supabaseUrl = configService.getOrThrow<string>('SUPABASE_URL');
    this.issuer = `${supabaseUrl}/auth/v1`;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<TimedRequest>();
    const route = `${req.method} ${req.originalUrl}`;
    const authHeader = req.headers.authorization;
    req.requestTimings ??= {};
    const guardStart = performance.now();

    try {
      const token = this.extractBearerToken(authHeader);

      const jwtStart = performance.now();
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['ES256'],
      });
      req.requestTimings.jwtVerify = this.elapsed(jwtStart);

      // attach raw payload for downstream use (e.g., accept-invite)
      req.authPayload = payload as SupabaseJwtPayload;

      try {
        const loadUserStart = performance.now();
        const authUser = await this.loadUserCached(
          payload as unknown as SupabaseJwtPayload,
        );
        req.requestTimings.authUser = this.elapsed(loadUserStart);
        req.user = authUser;
      } catch (userError) {
        // allow request to continue ONLY if user is not provisioned
        if (
          userError instanceof UnauthorizedException &&
          (userError.getResponse() as any)?.message ===
            'User not provisioned — complete invitation flow'
        ) {
          // skip user assignment, controller will handle provisioning
          return true;
        }

        throw userError;
      }

      req.requestTimings.jwtGuard = this.elapsed(guardStart);
      return true;
    } catch (error) {
      const reason = this.describe(error, authHeader);
      this.logger.warn(`401 on ${route} — ${reason}`);
      throw new UnauthorizedException(reason);
    }
  }

  private extractBearerToken(authHeader: string | undefined): string {
    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    if (!authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization header must start with "Bearer "');
    }

    const token = authHeader.slice(7).trim();

    if (!token) {
      throw new UnauthorizedException('Bearer token is empty');
    }

    return token;
  }

  private async loadUser(payload: SupabaseJwtPayload): Promise<AuthenticatedUser> {
    if (!payload.sub) {
      throw new UnauthorizedException('Missing sub in token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        role: true,
        userBranches: { select: { branchId: true } },
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not provisioned — complete invitation flow');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('User is inactive');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      tenantId: user.tenantId,
      roleId: user.roleId,
      roleCode: user.role.code,
      isRoot: user.role.code === 'ROOT',
      passwordSetAt: user.passwordSetAt,
      accessibleBranches: user.userBranches.map((ub) => ub.branchId),
    };
  }

  private async loadUserCached(
    payload: SupabaseJwtPayload,
  ): Promise<AuthenticatedUser> {
    if (!payload.sub) {
      throw new UnauthorizedException('Missing sub in token');
    }

    const now = Date.now();
    const cached = this.userCache.get(payload.sub);
    if (cached && cached.expiresAt > now) {
      return cached.user;
    }

    const pending = this.userLoads.get(payload.sub);
    if (pending) return pending;

    const load = this.loadUser(payload)
      .then((user) => {
        this.userCache.set(payload.sub!, {
          user,
          expiresAt: Date.now() + AUTH_USER_CACHE_TTL_MS,
        });
        return user;
      })
      .finally(() => {
        this.userLoads.delete(payload.sub!);
      });

    this.userLoads.set(payload.sub, load);
    return load;
  }

  private describe(error: unknown, authHeader: string | undefined): string {
    if (!authHeader) return 'Missing Authorization header';

    if (error instanceof UnauthorizedException) {
      const response = error.getResponse();
      if (typeof response === 'string') return response;
      if (typeof response === 'object' && response && 'message' in response) {
        const message = (response as { message?: string | string[] }).message;
        return Array.isArray(message) ? message.join(', ') : message ?? 'Unauthorized';
      }
    }

    if (error instanceof Error) {
      if (error.name === 'JWTExpired') return 'Token expired';
      return error.message || 'Invalid or missing token';
    }

    return 'Invalid or missing token';
  }

  private elapsed(start: number) {
    return performance.now() - start;
  }
}
