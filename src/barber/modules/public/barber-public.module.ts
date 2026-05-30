import { Module } from '@nestjs/common';
import { PublicSiteModule } from '../public-site/barber-public-site.module';
import { BarberPublicController } from './barber-public.controller';
import { BarberPublicService } from './barber-public.service';

@Module({
  imports: [PublicSiteModule],
  controllers: [BarberPublicController],
  providers: [BarberPublicService],
  exports: [BarberPublicService],
})
export class BarberPublicModule {}
