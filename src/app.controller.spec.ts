import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';

describe('AppController', () => {
  let appController: AppController;
  let queryRaw: jest.Mock;

  beforeEach(async () => {
    // `AppService` depende de Prisma desde que existe el readiness. Se inyecta
    // un doble y no el servicio real: estos tests no deben abrir una conexión a
    // Supabase —serían lentos y fallarían sin red—, y lo que se comprueba es la
    // traducción de "la DB no responde" a un 503, no que Postgres funcione.
    queryRaw = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  /**
   * Es el endpoint al que apunta el healthcheck de Railway
   * (`railway.json: healthcheckPath`), y de él depende CUÁNDO la plataforma
   * manda SIGTERM al contenedor viejo en un deploy. Que devuelva 200 con la DB
   * caída dejaría entrar tráfico a un POS que no puede facturar.
   */
  describe('health', () => {
    it('el liveness responde sin tocar la base', () => {
      expect(appController.health()).toMatchObject({ ok: true, status: 'up' });
      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('el readiness responde 200 cuando la base contesta', async () => {
      const result = await appController.ready();
      expect(result.ok).toBe(true);
      expect(result.db.ok).toBe(true);
      expect(queryRaw).toHaveBeenCalled();
    });

    it('el readiness responde 503 cuando la base no contesta', async () => {
      queryRaw.mockRejectedValue(new Error('connection refused'));
      await expect(appController.ready()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('no se queda colgado si la base nunca responde', async () => {
      // Una promesa que nunca resuelve: es el caso que de verdad pasa cuando
      // Supabase deja de contestar —no rechaza, se queda callada— y sin el
      // timeout de `pingDb` el healthcheck colgaría hasta que Railway lo mate.
      jest.useFakeTimers();
      queryRaw.mockReturnValue(new Promise(() => {}));
      // La expectativa se engancha ANTES de adelantar el reloj: si se hiciera
      // después, el rechazo quedaría un instante sin manejar y Node lo reporta
      // como unhandled rejection aunque el test sea correcto.
      const pending = expect(appController.ready()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await jest.advanceTimersByTimeAsync(3000);
      await pending;
      jest.useRealTimers();
    });
  });
});
