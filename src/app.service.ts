import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }

  health() {
    return {
      ok: true,
      status: 'up',
      timestamp: new Date().toISOString(),
    };
  }
}
