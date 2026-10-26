import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { AdminModule } from '../admin/admin.module';
import { PlanPricingService } from '../platform/pricing/plan-pricing.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PasswordSetGuard } from './guards/password-set.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { TenantGuard } from './guards/tenant.guard';
import { JwtStrategy } from './jwt.strategy';
import { AuthService } from './services/auth.service';
import { PermissionsCacheService } from './services/permissions-cache.service';
import { SupportAuditInterceptor } from './support/support-audit.interceptor';
import { SupportSessionController } from './support/support-session.controller';
import { SupportSessionService } from './support/support-session.service';

@Global()
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), AdminModule],
  controllers: [AuthController, SupportSessionController],
  providers: [
    AuthService,
    SupportSessionService,
    { provide: APP_INTERCEPTOR, useClass: SupportAuditInterceptor },
    JwtStrategy,
    JwtAuthGuard,
    TenantGuard,
    PermissionsGuard,
    PasswordSetGuard,
    PermissionsCacheService,
    // Provisto aquí y no importando PlatformModule: Platform → Alexa →
    // Assistant → Auth cerraría un ciclo. Es stateless (solo Prisma).
    PlanPricingService,
  ],
  exports: [
    JwtAuthGuard,
    TenantGuard,
    PermissionsGuard,
    PasswordSetGuard,
    PermissionsCacheService,
    SupportSessionService,
    PassportModule,
  ],
})
export class AuthModule {}
