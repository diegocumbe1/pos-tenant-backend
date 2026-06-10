import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
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
import { NotificationsModule } from './notifications/notifications.module';
import { PlatformModule } from './platform/platform.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
    NotificationsModule,
    PlatformModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
