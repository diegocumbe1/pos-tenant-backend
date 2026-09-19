import { Injectable } from '@nestjs/common';
import { AlexaSkill } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Las skills registradas, cacheadas en memoria.
 *
 * Se consulta en CADA petición de Alexa, antes de verificar la firma, así que
 * pegarle a Postgres cada vez sumaría un round-trip a Supabase al tiempo de
 * respuesta hablada. El caché es corto a propósito: registrar una skill desde
 * el super-admin debe surtir efecto sin reiniciar, y un minuto de espera es
 * aceptable. `invalidate()` lo vacía cuando la escritura pasa por este proceso.
 */
const TTL_MS = 60_000;

@Injectable()
export class AlexaSkillRepository {
  private cache = new Map<string, { skill: AlexaSkill | null; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async byApplicationId(applicationId: string): Promise<AlexaSkill | null> {
    const hit = this.cache.get(applicationId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.skill;

    const skill = await this.prisma.alexaSkill.findFirst({
      where: { applicationId, isActive: true },
    });
    this.cache.set(applicationId, { skill, at: Date.now() });
    return skill;
  }

  invalidate(): void {
    this.cache.clear();
  }
}
