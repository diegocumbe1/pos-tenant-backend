import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseJwtPayload } from './types/jwt-payload.interface';
import { AUTH_USER_INCLUDE, toAuthenticatedUser } from './helpers/tenant-access';
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
      include: AUTH_USER_INCLUDE,
    });

    if (!user) {
      throw new UnauthorizedException('User not provisioned — complete invitation flow');
    }
    if (!user.isActive) {
      throw new UnauthorizedException('User is inactive');
    }

    return toAuthenticatedUser(user);
  }
}
