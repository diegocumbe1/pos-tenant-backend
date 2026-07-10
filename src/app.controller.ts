import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** Liveness: 200 mientras el proceso viva. */
  @Get('health')
  health() {
    return this.appService.health();
  }

  /** Readiness: 200 si la DB responde, 503 si no. Apuntar aquí los monitores. */
  @Get('health/ready')
  async ready() {
    const result = await this.appService.readiness();
    if (!result.ok) {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
