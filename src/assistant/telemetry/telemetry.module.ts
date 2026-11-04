import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AssistantTelemetryController } from './telemetry.controller';
import { AssistantTelemetryService } from './telemetry.service';
import { AssistantQuotaService } from './assistant-quota.service';
@Module({
  imports: [AuthModule],
  controllers: [AssistantTelemetryController],
  providers: [AssistantTelemetryService, AssistantQuotaService],
  exports: [AssistantTelemetryService, AssistantQuotaService],
})
export class AssistantTelemetryModule {}
