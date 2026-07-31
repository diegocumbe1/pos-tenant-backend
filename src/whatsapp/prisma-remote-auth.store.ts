import * as fs from 'fs';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Store de sesión para whatsapp-web.js `RemoteAuth`, respaldado por Postgres
 * (tabla whatsapp_sessions). Persiste el zip de credenciales en DB, de modo que
 * la sesión sobrevive a redeploys y funciona igual en local/prod.
 *
 * Contrato esperado por RemoteAuth (ver node_modules/whatsapp-web.js/src/authStrategies/RemoteAuth.js):
 *  - sessionExists({ session })            -> boolean
 *  - save({ session })                     -> lee `${session}.zip` y lo persiste
 *  - extract({ session, path })            -> escribe el zip guardado en `path`
 *  - delete({ session })                   -> elimina la sesión
 *
 * Cada instancia está ligada a un (tenantId, branchId) → conoce su clientId.
 */
export class PrismaRemoteAuthStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clientId: string,
    private readonly tenantId: string,
    private readonly branchId: string,
  ) {}

  async sessionExists(_options: { session: string }): Promise<boolean> {
    const row = await this.prisma.whatsappSession.findUnique({
      where: { clientId: this.clientId },
      select: { data: true },
    });
    return !!row?.data && row.data.length > 0;
  }

  async save(options: { session: string }): Promise<void> {
    // RemoteAuth ya generó el zip en `${options.session}.zip`.
    const zipPath = `${options.session}.zip`;
    const data = await fs.promises.readFile(zipPath);
    await this.prisma.whatsappSession.upsert({
      where: { clientId: this.clientId },
      create: {
        clientId: this.clientId,
        tenantId: this.tenantId,
        branchId: this.branchId,
        data,
      },
      update: { data },
    });
  }

  async extract(options: { session: string; path: string }): Promise<void> {
    const row = await this.prisma.whatsappSession.findUnique({
      where: { clientId: this.clientId },
      select: { data: true },
    });
    if (!row?.data) throw new Error(`No stored WhatsApp session for ${this.clientId}`);
    await fs.promises.writeFile(options.path, row.data);
  }

  async delete(_options: { session: string }): Promise<void> {
    await this.prisma.whatsappSession
      .delete({ where: { clientId: this.clientId } })
      .catch(() => undefined); // idempotente
  }
}
