import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AlexaController } from './alexa.controller';
import { AlexaAuthService } from './alexa-auth.service';
import { AlexaService } from './alexa.service';

@Module({
  imports: [ConfigModule],
  controllers: [AlexaController],
  providers: [AlexaService, AlexaAuthService],
})
export class AlexaModule {}
