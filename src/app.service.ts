import { Injectable } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

@Injectable()
export class AppService {
  constructor(private readonly prisma: PrismaService) {}

  getHello(): string {
    return 'Hello World!';
  }

  /**
   * Liveness: el proceso responde. No toca la DB — sirve para saber que el
   * contenedor está arriba aunque Supabase tenga un problema.
   */
  health() {
    return {
      ok: true,
      status: 'up',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness: verifica que la DB (Supabase) responde. Es el que deben apuntar
   * Railway y el monitor externo, porque una caída de Supabase deja al POS sin
   * poder facturar aunque el proceso siga vivo. Devuelve ok:false si la DB no
   * responde dentro del timeout; el controller lo traduce a HTTP 503.
   */
  async readiness() {
    const timestamp = new Date().toISOString();
    const startedAt = Date.now();
    try {
      await this.pingDb(2500);
      return {
        ok: true,
        status: 'up',
        db: { ok: true, latencyMs: Date.now() - startedAt },
        timestamp,
      };
    } catch (err) {
      return {
        ok: false,
        status: 'degraded',
        db: {
          ok: false,
          error: err instanceof Error ? err.message : 'unknown',
        },
        timestamp,
      };
    }
  }

  private async pingDb(timeoutMs: number) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`db ping timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    try {
      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
