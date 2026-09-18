import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import { AssistantService } from './assistant.service';

@Module({
  imports: [PlatformModule],
  providers: [AssistantService],
  exports: [AssistantService],
})
export class AssistantModule {}
