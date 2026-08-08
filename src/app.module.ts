import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { SupabaseModule } from './supabase/supabase.module';
import { AuthModule } from './auth/auth.module';
import { AdminModule } from './admin/admin.module';
import { TenantAdminModule } from './tenant-admin/tenant-admin.module';
import { RestaurantModule } from './restaurant/restaurant.module';
import { RealtimeModule } from './realtime/realtime.module';
import { FinanceModule } from './finance/finance.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { AssetsModule } from './assets/assets.module';
import { BarberModule } from './barber/barber.module';
import { RetailModule } from './retail/retail.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PlatformModule } from './platform/platform.module';
import { PlatformMessagingModule } from './platform-messaging/platform-messaging.module';
import { StaffCompensationModule } from './staff-compensation/staff-compensation.module';
import { LoggingInterceptor } from './monitoring/logging.interceptor';
import { RequestMetricsMiddleware } from './monitoring/request-metrics.middleware';

@Module({
  imports: [
    // `.env.local` primero: en desarrollo apunta la base a la réplica de Docker
    // sin tocar `.env`, donde siguen las credenciales de producción. En el deploy
    // no existe `.env.local` (está en .gitignore) y manda el entorno de Railway.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.local', '.env'] }),
    EventEmitterModule.forRoot(),
    PrismaModule,
    SupabaseModule,
    AuthModule,
    AdminModule,
    TenantAdminModule,
    RestaurantModule,
    RealtimeModule,
    FinanceModule,
    WhatsAppModule,
    AssetsModule,
    BarberModule,
    RetailModule,
    NotificationsModule,
    PlatformModule,
    PlatformMessagingModule,
    StaffCompensationModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    RequestMetricsMiddleware,
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestMetricsMiddleware).forRoutes('*');
  }
}
