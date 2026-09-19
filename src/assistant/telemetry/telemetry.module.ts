import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AssistantTelemetryController } from './telemetry.controller';
import { AssistantTelemetryService } from './telemetry.service';
@Module({
  imports: [AuthModule],
  controllers: [AssistantTelemetryController],
  providers: [AssistantTelemetryService],
  exports: [AssistantTelemetryService],
})
export class AssistantTelemetryModule {}
