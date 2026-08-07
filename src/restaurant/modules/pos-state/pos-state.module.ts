import { Module } from '@nestjs/common';
import { PosStateController } from './pos-state.controller';
import { PosStateService } from './pos-state.service';

@Module({
  controllers: [PosStateController],
  providers: [PosStateService],
})
export class PosStateModule {}
