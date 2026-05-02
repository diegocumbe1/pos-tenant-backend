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

  async isReady(tenantId: string, branchId: string): Promise<boolean> {
    return this.sessions.get(sessionKey(tenantId, branchId))?.status === 'ready';
  }

  getClient(tenantId: string, branchId: string): Client | undefined {
    return this.sessions.get(sessionKey(tenantId, branchId))?.client;
  }

  async pair(tenantId: string, branchId: string): Promise<{ status: SessionStatus }> {
    const key = sessionKey(tenantId, branchId);
    const existing = this.sessions.get(key);
    if (existing && (existing.status === 'ready' || existing.status === 'authenticated')) {
      return { status: existing.status };
    }
    if (existing && existing.status === 'initializing') {
      return { status: existing.status };
    }

    const headless = (process.env.WA_PUPPETEER_HEADLESS ?? 'true') !== 'false';
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: safeClientId(tenantId, branchId),
        dataPath: this.dataPath,
      }),
      puppeteer: {
        headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    const state: SessionState = { client, status: 'initializing' };
    this.sessions.set(key, state);
    this.emit(tenantId, branchId, state);

    client.on('qr', async (qr) => {
      try {
        state.qrDataUrl = await QRCode.toDataURL(qr);
        state.status = 'qr_ready';
        this.emit(tenantId, branchId, state);
      } catch (err) {
        state.status = 'error';
        state.lastError = (err as Error).message;
        this.emit(tenantId, branchId, state);
      }
    });

    client.on('authenticated', () => {
      state.status = 'authenticated';
      state.qrDataUrl = undefined;
      this.emit(tenantId, branchId, state);
    });

    client.on('ready', () => {
      state.status = 'ready';
      state.phoneNumber = client.info?.wid?.user;
      this.emit(tenantId, branchId, state);
    });

    client.on('auth_failure', (msg) => {
      state.status = 'error';
      state.lastError = msg;
      this.emit(tenantId, branchId, state);
    });

    client.on('disconnected', (reason) => {
      state.status = 'disconnected';
      state.lastError = reason;
      this.emit(tenantId, branchId, state);
    });

    client.initialize().catch((err) => {
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
    if (!state) return;
    try {
      await state.client.logout();
    } catch (err) {
      this.logger.warn(`logout() failed for ${key}: ${(err as Error).message}`);
    }
    try {
      await state.client.destroy();
    } catch (err) {
      this.logger.warn(`destroy() failed for ${key}: ${(err as Error).message}`);
    }
    this.sessions.delete(key);

    const sessionDir = path.join(this.dataPath, `session-${safeClientId(tenantId, branchId)}`);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    this.events.emit('wa.status', { tenantId, branchId, status: 'idle' });
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
}
