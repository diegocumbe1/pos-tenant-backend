import { Module } from '@nestjs/common';
import { AdminUsersController } from './admin-users.controller';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  controllers: [AdminController, AdminUsersController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
