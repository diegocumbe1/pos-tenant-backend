import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Client, LocalAuth } from 'whatsapp-web.js';
import * as QRCode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';

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
}

const sessionKey = (tenantId: string, branchId: string) => `${tenantId}:${branchId}`;

const safeClientId = (tenantId: string, branchId: string) =>
  `${tenantId}_${branchId}`.replace(/[^a-zA-Z0-9_-]/g, '_');

@Injectable()
export class WhatsAppSessionManager implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppSessionManager.name);
  private readonly sessions = new Map<string, SessionState>();
  private readonly dataPath = process.env.WA_SESSION_DIR
    ? path.resolve(process.env.WA_SESSION_DIR)
    : path.resolve(process.cwd(), '.wa-sessions');
  private readonly pairTimeoutMs = Number(process.env.WA_PAIR_TIMEOUT_MS ?? 60000);

  constructor(private readonly events: EventEmitter2) {}

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

    fs.mkdirSync(this.dataPath, { recursive: true });

    const headless = (process.env.WA_PUPPETEER_HEADLESS ?? 'true') !== 'false';
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: safeClientId(tenantId, branchId),
        dataPath: this.dataPath,
      }),
      puppeteer: {
        headless,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
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
      state.status = 'authenticated';
      state.qrDataUrl = undefined;
      this.emit(tenantId, branchId, state);
    });

    client.on('ready', () => {
      this.clearInitializeTimeout(state);
      state.status = 'ready';
      state.phoneNumber = client.info?.wid?.user;
      this.emit(tenantId, branchId, state);
    });

    client.on('auth_failure', (msg) => {
      this.clearInitializeTimeout(state);
      state.status = 'error';
      state.lastError = msg;
      this.emit(tenantId, branchId, state);
    });

    client.on('disconnected', (reason) => {
      this.clearInitializeTimeout(state);
      state.status = 'disconnected';
      state.lastError = reason;
      this.emit(tenantId, branchId, state);
    });

    client.initialize().catch((err) => {
      this.clearInitializeTimeout(state);
      this.logger.error(`initialize() failed for ${key}: ${(err as Error).message}`);
      state.status = 'error';
      state.lastError = (err as Error).message;
      this.emit(tenantId, branchId, state);
    });

    return { status: state.status };
  }

  async disconnect(tenantId: string, branchId: string): Promise<void> {
    const key = sessionKey(tenantId, branchId);
    const state = this.sessions.get(key);
    if (state) {
      await this.destroyClient(key, state, { logout: true });
    }

    const sessionDir = this.getSessionDir(tenantId, branchId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    this.events.emit('wa.status', { tenantId, branchId, status: 'idle' });
  }

  private getSessionDir(tenantId: string, branchId: string) {
    return path.join(this.dataPath, `session-${safeClientId(tenantId, branchId)}`);
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

  private async destroyClient(
    key: string,
    state: SessionState,
    options: { logout?: boolean; remove?: boolean } = {},
  ) {
    const { logout = false, remove = true } = options;
    this.clearInitializeTimeout(state);
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
