import { Module } from '@nestjs/common';
import { BarberSharedModule } from '../../../shared/barber-shared.module';
import { InMoveSyncController } from './inmove-sync.controller';
import { InMoveSyncService } from './inmove-sync.service';

@Module({
  imports: [BarberSharedModule],
  controllers: [InMoveSyncController],
  providers: [InMoveSyncService],
})
export class InMoveSyncModule {}
