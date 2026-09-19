import { Module } from '@nestjs/common';
import { AssistantModule } from '../../assistant/assistant.module';
import { AlexaController } from './alexa.controller';
import { AlexaAuthService } from './alexa-auth.service';
import { AlexaSkillRepository } from './alexa-skill.repository';
import { AlexaSkillsService } from './alexa-skills.service';
import { AlexaService } from './alexa.service';

@Module({
  imports: [AssistantModule],
  controllers: [AlexaController],
  providers: [
    AlexaService,
    AlexaAuthService,
    AlexaSkillRepository,
    AlexaSkillsService,
  ],
  // La administración de skills la expone el backoffice de plataforma.
  exports: [AlexaSkillsService],
})
export class AlexaModule {}
