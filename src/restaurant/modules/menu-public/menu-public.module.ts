import { Module } from '@nestjs/common';
import {
  MenuPublicController,
  PublicMenuController,
} from './menu-public.controller';
import { MenuPublicService } from './menu-public.service';

@Module({
  controllers: [MenuPublicController, PublicMenuController],
  providers: [MenuPublicService],
  exports: [MenuPublicService],
})
export class MenuPublicModule {}
