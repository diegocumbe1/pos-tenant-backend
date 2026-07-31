import {
  ConflictException,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Client, RemoteAuth } from 'whatsapp-web.js';
import * as QRCode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { PrismaRemoteAuthStore } from './prisma-remote-auth.store';

export type SessionStatus =
  | 'idle'
  | 'initializing'
  | 'qr_ready'
  | 'authenticated'
  | 'ready'
  | 'disconnected'
  | 'error';

interface SessionState {
  client: Client;
  status: SessionStatus;
  qrDataUrl?: string;
  phoneNumber?: string;
  lastError?: string;
  initializeTimeout?: NodeJS.Timeout;
  readyTimeout?: NodeJS.Timeout;
}

const sessionKey = (tenantId: string, branchId: string) => `${tenantId}:${branchId}`;

const safeClientId = (tenantId: string, branchId: string) =>
  `${tenantId}_${branchId}`.replace(/[^a-zA-Z0-9_-]/g, '_');

@Injectable()
export class WhatsAppSessionManager
  implements OnModuleDestroy, OnApplicationBootstrap
{
  private readonly logger = new Logger(WhatsAppSessionManager.name);
  private readonly sessions = new Map<string, SessionState>();
  private readonly dataPath = process.env.WA_SESSION_DIR
    ? path.resolve(process.env.WA_SESSION_DIR)
    : path.resolve(process.cwd(), '.wa-sessions');
  private readonly pairTimeoutMs = Number(process.env.WA_PAIR_TIMEOUT_MS ?? 60000);
  private readonly readyTimeoutMs = Number(process.env.WA_READY_TIMEOUT_MS ?? 120000);
  private readonly maxActiveSessions = Number(process.env.WA_MAX_ACTIVE_SESSIONS ?? 1);
  // Respaldo periódico de la sesión a DB (RemoteAuth). Mínimo permitido: 60s.
  private readonly backupSyncIntervalMs = Math.max(
    60000,
    Number(process.env.WA_BACKUP_SYNC_MS ?? 1800000),
  );

  constructor(
    private readonly events: EventEmitter2,
    private readonly prisma: PrismaService,
  ) {}

  // Reconecta al arrancar las sesiones ya guardadas en DB (sin QR). Así WhatsApp
  // sigue conectado tras redeploys/reinicios, en cualquier ambiente.
  async onApplicationBootstrap() {
    try {
      const saved = await this.prisma.whatsappSession.findMany({
        where: { data: { not: null } },
        select: { tenantId: true, branchId: true },
        orderBy: { updatedAt: 'desc' },
        take: this.maxActiveSessions,
      });
      for (const s of saved) {
        this.logger.log(
          `Restaurando sesión WhatsApp guardada: ${s.tenantId}/${s.branchId}`,
        );
        await this.pair(s.tenantId, s.branchId).catch((err) =>
          this.logger.warn(
            `No se pudo restaurar ${s.tenantId}/${s.branchId}: ${(err as Error).message}`,
          ),
        );
      }
    } catch (err) {
      this.logger.warn(
        `Restore-on-boot de WhatsApp falló: ${(err as Error).message}`,
      );
    }
  }

  async onModuleDestroy() {
    for (const [key, state] of this.sessions) {
      try {
        await state.client.destroy();
      } catch (err) {
        this.logger.warn(`Failed to destroy client ${key}: ${(err as Error).message}`);
      }
    }
  }

  getStatus(tenantId: string, branchId: string) {
    const state = this.sessions.get(sessionKey(tenantId, branchId));
    if (!state) return { status: 'idle' as SessionStatus };
    return {
      status: state.status,
      qr: state.qrDataUrl,
      phoneNumber: state.phoneNumber,
      error: state.lastError,
    };
  }

  getDiagnostics(tenantId: string, branchId: string) {
    const key = sessionKey(tenantId, branchId);
    const sessionDir = this.getSessionDir(tenantId, branchId);
    let dataPathWritable = false;
    try {
      fs.mkdirSync(this.dataPath, { recursive: true });
      fs.accessSync(this.dataPath, fs.constants.W_OK);
      dataPathWritable = true;
    } catch (err) {
      this.logger.warn(`WA session directory is not writable: ${(err as Error).message}`);
    }

    return {
      tenantId,
      branchId,
      key,
      status: this.getStatus(tenantId, branchId),
      activeInMemory: this.sessions.has(key),
      dataPath: this.dataPath,
      dataPathExists: fs.existsSync(this.dataPath),
      dataPathWritable,
      sessionDir,
      sessionDirExists: fs.existsSync(sessionDir),
      chromiumExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: (process.env.WA_PUPPETEER_HEADLESS ?? 'true') !== 'false',
      pairTimeoutMs: this.pairTimeoutMs,
      readyTimeoutMs: this.readyTimeoutMs,
      maxActiveSessions: this.maxActiveSessions,
      activeSessions: this.sessions.size,
      memory: process.memoryUsage(),
    };
  }

  async isReady(tenantId: string, branchId: string): Promise<boolean> {
    return this.sessions.get(sessionKey(tenantId, branchId))?.status === 'ready';
  }

  getClient(tenantId: string, branchId: string): Client | undefined {
    return this.sessions.get(sessionKey(tenantId, branchId))?.client;
  }

  async pair(tenantId: string, branchId: string): Promise<{ status: SessionStatus }> {
    const key = sessionKey(tenantId, branchId);
    const existing = this.sessions.get(key);
    if (
      existing &&
      ['initializing', 'qr_ready', 'authenticated', 'ready'].includes(existing.status)
    ) {
      return { status: existing.status };
    }

    if (existing) {
      await this.destroyClient(key, existing);
    }

    if (this.sessions.size >= this.maxActiveSessions) {
      throw new ConflictException(
        `WhatsApp pairing is already active for another tenant/branch. Max active sessions: ${this.maxActiveSessions}`,
      );
    }

    fs.mkdirSync(this.dataPath, { recursive: true });

    const headless = (process.env.WA_PUPPETEER_HEADLESS ?? 'true') !== 'false';
    const clientId = safeClientId(tenantId, branchId);
    const client = new Client({
      // WhatsApp publica versiones nuevas de WhatsApp Web que rompen la
      // inyección de whatsapp-web.js (síntoma: "Execution context was
      // destroyed" en initialize()). Por defecto la librería no fija ninguna
      // —su webVersion default no está en el cache local— y acaba usando la
      // última en vivo. Fijamos una versión conocida buena, servida desde el
      // archivo remoto para que funcione igual en local y en prod sin depender
      // de .wwebjs_cache. Si WhatsApp la retira (expiran ~2 meses), basta con
      // mover WA_WEB_VERSION a otra sin redeploy de código.
      webVersion: process.env.WA_WEB_VERSION ?? '2.3000.1043890899-alpha',
      webVersionCache: {
        type: 'remote',
        remotePath:
          process.env.WA_WEB_VERSION_PATH ??
          'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html',
      },
      // Sesión persistida en DB (sobrevive redeploys, igual en local/prod).
      authStrategy: new RemoteAuth({
        clientId,
        dataPath: this.dataPath,
        backupSyncIntervalMs: this.backupSyncIntervalMs,
        store: new PrismaRemoteAuthStore(
          this.prisma,
          clientId,
          tenantId,
          branchId,
        ),
      }),
      puppeteer: {
        headless,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        timeout: Number(process.env.WA_PUPPETEER_TIMEOUT_MS ?? 60000),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--no-first-run',
          '--no-zygote',
          '--renderer-process-limit=1',
          '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,site-per-process',
        ],
      },
    });

    const state: SessionState = { client, status: 'initializing' };
    this.sessions.set(key, state);
    this.emit(tenantId, branchId, state);

    state.initializeTimeout = setTimeout(() => {
      if (state.status !== 'initializing') return;
      this.logger.warn(`Pairing timed out for ${key} after ${this.pairTimeoutMs}ms`);
      state.status = 'error';
      state.lastError =
        'WhatsApp pairing timed out before a QR code was emitted. Check Chromium/Render logs and retry.';
      this.emit(tenantId, branchId, state);
      void this.destroyClient(key, state, { remove: false });
    }, this.pairTimeoutMs);

    client.on('loading_screen', (percent, message) => {
      this.logger.debug(`WhatsApp loading ${key}: ${percent}% ${message}`);
    });

    client.on('change_state', (status) => {
      this.logger.debug(`WhatsApp state changed ${key}: ${status}`);
    });

    client.on('qr', async (qr) => {
      try {
        this.clearInitializeTimeout(state);
        state.qrDataUrl = await QRCode.toDataURL(qr);
        state.status = 'qr_ready';
        this.emit(tenantId, branchId, state);
      } catch (err) {
        this.clearInitializeTimeout(state);
        state.status = 'error';
        state.lastError = (err as Error).message;
        this.emit(tenantId, branchId, state);
      }
    });

    client.on('authenticated', () => {
      this.clearInitializeTimeout(state);
      this.startReadyTimeout(key, tenantId, branchId, state);
      state.status = 'authenticated';
      state.qrDataUrl = undefined;
      this.emit(tenantId, branchId, state);
    });

    client.on('ready', () => {
      this.clearTimeouts(state);
      state.status = 'ready';
      state.phoneNumber = client.info?.wid?.user;
      this.emit(tenantId, branchId, state);
      // Guarda el número (best-effort; la fila la crea el primer backup del store).
      if (state.phoneNumber) {
        this.prisma.whatsappSession
          .updateMany({
            where: { clientId },
            data: { phoneNumber: state.phoneNumber },
          })
          .catch(() => undefined);
      }
    });

    client.on('remote_session_saved', () => {
      this.logger.debug(`WhatsApp session persisted to DB for ${key}`);
    });

    client.on('auth_failure', (msg) => {
      this.clearTimeouts(state);
      state.status = 'error';
      state.lastError = msg;
      this.emit(tenantId, branchId, state);
    });

    client.on('disconnected', (reason) => {
      this.clearTimeouts(state);
      state.status = 'disconnected';
      state.lastError = String(reason);
      this.emit(tenantId, branchId, state);

      // Si el usuario desvinculó el dispositivo DESDE EL CELULAR (logout/unpaired),
      // la sesión murió: se limpia la persistencia en DB para no intentar
      // reconectarla al arrancar y para que la UI pida un QR nuevo.
      const terminal = ['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE', 'CONFLICT'];
      const isTerminal = terminal.includes(String(reason).toUpperCase());
      void this.destroyClient(key, state, { remove: true }).then(() => {
        if (isTerminal) {
          this.prisma.whatsappSession
            .delete({ where: { clientId } })
            .catch(() => undefined);
          for (const dir of this.localSessionDirs(clientId)) {
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
          }
          this.events.emit('wa.status', { tenantId, branchId, status: 'idle' });
        }
      });
    });

    setImmediate(() => {
      client.initialize().catch((err) => {
        this.clearTimeouts(state);
        this.logger.error(`initialize() failed for ${key}: ${(err as Error).message}`);
        state.status = 'error';
        state.lastError = (err as Error).message;
        this.emit(tenantId, branchId, state);
        // Sin esto el Chromium queda vivo: se fuga ~400 MB por intento fallido
        // y el perfil sigue bloqueado, así que el reintento también falla.
        void this.destroyClient(key, state, { remove: false });
      });
    });

    return { status: state.status };
  }

  async disconnect(tenantId: string, branchId: string): Promise<void> {
    const key = sessionKey(tenantId, branchId);
    const state = this.sessions.get(key);
    if (state) {
      await this.destroyClient(key, state, { logout: true });
    }

    // Borra la sesión persistida en DB (idempotente) + carpetas temporales locales.
    const clientId = safeClientId(tenantId, branchId);
    await this.prisma.whatsappSession
      .delete({ where: { clientId } })
      .catch(() => undefined);
    for (const dir of this.localSessionDirs(clientId)) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    this.events.emit('wa.status', { tenantId, branchId, status: 'idle' });
  }

  // Carpetas de trabajo locales de RemoteAuth (efímeras; la fuente real es la DB).
  private localSessionDirs(clientId: string): string[] {
    return [
      path.join(this.dataPath, `RemoteAuth-${clientId}`),
      path.join(this.dataPath, `wwebjs_temp_session_${clientId}`),
    ];
  }

  private getSessionDir(tenantId: string, branchId: string) {
    return path.join(this.dataPath, `RemoteAuth-${safeClientId(tenantId, branchId)}`);
  }

  private emit(tenantId: string, branchId: string, state: SessionState) {
    this.events.emit('wa.status', {
      tenantId,
      branchId,
      status: state.status,
      qr: state.qrDataUrl,
      phoneNumber: state.phoneNumber,
      error: state.lastError,
    });
  }

  private clearInitializeTimeout(state: SessionState) {
    if (!state.initializeTimeout) return;
    clearTimeout(state.initializeTimeout);
    state.initializeTimeout = undefined;
  }

  private clearReadyTimeout(state: SessionState) {
    if (!state.readyTimeout) return;
    clearTimeout(state.readyTimeout);
    state.readyTimeout = undefined;
  }

  private clearTimeouts(state: SessionState) {
    this.clearInitializeTimeout(state);
    this.clearReadyTimeout(state);
  }

  private startReadyTimeout(
    key: string,
    tenantId: string,
    branchId: string,
    state: SessionState,
  ) {
    this.clearReadyTimeout(state);
    state.readyTimeout = setTimeout(() => {
      if (state.status !== 'authenticated') return;
      this.logger.warn(`Ready timed out for ${key} after ${this.readyTimeoutMs}ms`);
      state.status = 'error';
      state.lastError =
        'WhatsApp was authenticated but did not become ready before timeout. The browser was closed to avoid memory exhaustion.';
      this.emit(tenantId, branchId, state);
      void this.destroyClient(key, state, { remove: false });
    }, this.readyTimeoutMs);
  }

  private async destroyClient(
    key: string,
    state: SessionState,
    options: { logout?: boolean; remove?: boolean } = {},
  ) {
    const { logout = false, remove = true } = options;
    this.clearTimeouts(state);
    if (logout) {
      try {
        await state.client.logout();
      } catch (err) {
        this.logger.warn(`logout() failed for ${key}: ${(err as Error).message}`);
      }
    }
    try {
      await state.client.destroy();
    } catch (err) {
      this.logger.warn(`destroy() failed for ${key}: ${(err as Error).message}`);
    }
    if (remove) {
      this.sessions.delete(key);
    }
  }
}
