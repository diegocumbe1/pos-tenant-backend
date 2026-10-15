import { Global, Module } from '@nestjs/common';
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

@Global()
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' }), AdminModule],
  controllers: [AuthController],
  providers: [
    AuthService,
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
    PassportModule,
  ],
})
export class AuthModule {}
