import { Module } from '@nestjs/common';
import { SupabaseModule } from '../../../supabase/supabase.module';
import { PublicSiteStrategiesModule } from '../../../public-site/public-site-strategies.module';
import { PublicSiteController } from './barber-public-site.controller';
import { PublicSiteService } from './barber-public-site.service';
import { PublicSitePublicController } from './public-site-public.controller';

@Module({
  imports: [SupabaseModule, PublicSiteStrategiesModule],
  controllers: [PublicSiteController, PublicSitePublicController],
  providers: [PublicSiteService],
  exports: [PublicSiteService],
})
export class PublicSiteModule {}
