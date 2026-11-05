import {
  Controller,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { AlexaAdminService } from './alexa-admin.service';

/** Skill privada del super-admin. La autenticación es la firma de Amazon. */
@Controller('integrations/alexa-admin')
export class AlexaAdminController {
  constructor(private readonly admin: AlexaAdminService) {}

  @Post()
  @HttpCode(200)
  handleRequest(@Req() req: RawBodyRequest<Request>) {
    return this.admin.handleRequest(req.rawBody, req.headers);
  }
}
