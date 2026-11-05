import { Module } from '@nestjs/common';
import { AssistantModule } from '../../assistant/assistant.module';
import { AlexaAdminController } from './alexa-admin.controller';
import { AlexaAdminService } from './alexa-admin.service';
import { AlexaController } from './alexa.controller';
import { AlexaAuthService } from './alexa-auth.service';
import { AlexaSkillRepository } from './alexa-skill.repository';
import { AlexaSkillsService } from './alexa-skills.service';
import { AlexaService } from './alexa.service';

@Module({
  imports: [AssistantModule],
  controllers: [AlexaController, AlexaAdminController],
  providers: [
    AlexaService,
    AlexaAdminService,
    AlexaAuthService,
    AlexaSkillRepository,
    AlexaSkillsService,
  ],
  // La administración de skills la expone el backoffice de plataforma.
  exports: [AlexaSkillsService],
})
export class AlexaModule {}
