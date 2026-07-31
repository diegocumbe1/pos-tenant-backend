import { Module } from '@nestjs/common';
import { StaffCompensationController } from './staff-compensation.controller';
import { StaffCompensationService } from './staff-compensation.service';

@Module({
  controllers: [StaffCompensationController],
  providers: [StaffCompensationService],
})
export class StaffCompensationModule {}
