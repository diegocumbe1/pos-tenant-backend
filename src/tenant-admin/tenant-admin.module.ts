import { Module } from '@nestjs/common';
import { TenantAdminController } from './tenant-admin.controller';
import { TenantAdminService } from './tenant-admin.service';

@Module({
  controllers: [TenantAdminController],
  providers: [TenantAdminService],
  exports: [TenantAdminService],
})
export class TenantAdminModule {}
