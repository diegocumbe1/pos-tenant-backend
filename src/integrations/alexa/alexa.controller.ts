import {
  Controller,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { AlexaService } from './alexa.service';

@Controller('integrations/alexa')
export class AlexaController {
  constructor(private readonly alexa: AlexaService) {}

  @Post()
  @HttpCode(200)
  handleRequest(@Req() req: RawBodyRequest<Request>) {
    return this.alexa.handleRequest(req.rawBody, req.headers);
  }
}
