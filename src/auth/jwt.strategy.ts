import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseJwtPayload } from './types/jwt-payload.interface';
import { AuthenticatedUser } from './types/tenant-context.interface';
import * as jwksRsa from 'jwks-rsa';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      audience: 'authenticated',
      issuer: configService.getOrThrow<string>('SUPABASE_URL') + '/auth/v1',
      algorithms: ['ES256'],
      secretOrKeyProvider: jwksRsa.passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri:
          configService.getOrThrow<string>('SUPABASE_URL') +
          '/auth/v1/.well-known/jwks.json',
      }) as any,
    });
  }

  async validate(payload: SupabaseJwtPayload): Promise<AuthenticatedUser> {
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
}
