import * as crypto from 'crypto';
import * as fs from 'fs';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * Store de sesión para whatsapp-web.js `RemoteAuth`, respaldado por Supabase
 * Storage (bucket privado). El zip de credenciales pesa ~30MB: guardarlo en
 * Postgres significaba reescribir la fila entera (TOAST + WAL) en cada backup
 * periódico, lo que agotaba el Disk IO budget del proyecto y hacía la DB más
 * grande que todo el resto de tablas juntas.
 *
 * En Postgres solo queda la fila índice de `whatsapp_sessions` (unos pocos
 * bytes: path, hash, teléfono), suficiente para saber qué sesiones restaurar
 * al arrancar sin tocar el blob.
 *
 * Contrato esperado por RemoteAuth (ver node_modules/whatsapp-web.js/src/authStrategies/RemoteAuth.js):
 *  - sessionExists({ session })            -> boolean
 *  - save({ session })                     -> lee `${session}.zip` y lo persiste
 *  - extract({ session, path })            -> escribe el zip guardado en `path`
 *  - delete({ session })                   -> elimina la sesión
 *
 * Cada instancia está ligada a un (tenantId, branchId) → conoce su clientId.
 */
/**
 * Ruta del zip en el bucket privado. Fuente única: el manager también borra
 * este objeto al desvincular, y si cada lado armara la ruta por su cuenta un
 * cambio de convención dejaría zips huérfanos ocupando espacio.
 */
export const waSessionObjectPath = (clientId: string): string =>
  `whatsapp-sessions/${clientId}.zip`;

export class StorageRemoteAuthStore {
  private readonly logger = new Logger(StorageRemoteAuthStore.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly clientId: string,
    private readonly tenantId: string,
    private readonly branchId: string,
  ) {}

  private get objectPath(): string {
    return waSessionObjectPath(this.clientId);
  }

  async sessionExists(_options: { session: string }): Promise<boolean> {
    const stat = await this.supabase.statPrivateFile(this.objectPath);
    return !!stat && stat.size > 0;
  }

  async save(options: { session: string }): Promise<void> {
    // RemoteAuth invoca save() desde un `setInterval(async …)` SIN catch
    // (RemoteAuth.js:99). Cualquier throw aquí es un unhandled rejection, y en
    // Node 22 eso tumba el proceso. Por eso el cuerpo entero va dentro del try
    // —incluidas la lectura del zip y la consulta a la DB, que también fallan—:
    // un backup fallido solo se registra y el siguiente ciclo lo reintenta.
    try {
      // RemoteAuth ya generó el zip en `${options.session}.zip`.
      const data = await fs.promises.readFile(`${options.session}.zip`);
      const hash = crypto.createHash('sha256').update(data).digest('hex');

      const row = await this.prisma.whatsappSession.findUnique({
        where: { clientId: this.clientId },
        select: { dataHash: true, storagePath: true },
      });

      // El backup corre cada N minutos aunque la sesión no haya cambiado: si el
      // zip es idéntico al último subido, no hay nada que escribir.
      if (row?.dataHash === hash && row?.storagePath === this.objectPath) {
        this.logger.debug(`Sesión ${this.clientId} sin cambios, backup omitido`);
        return;
      }

      // El plan Free de Supabase rechaza objetos de más de 50MB. Avisar antes de
      // llegar al tope, porque cuando falle la sesión dejará de respaldarse.
      const mb = data.length / 1024 / 1024;
      if (mb > 45) {
        this.logger.warn(
          `El zip de sesión de ${this.clientId} pesa ${mb.toFixed(1)} MB; el límite del bucket son 50 MB`,
        );
      }

      await this.supabase.uploadPrivateFile({
        path: this.objectPath,
        buffer: data,
        contentType: 'application/zip',
      });

      await this.prisma.whatsappSession.upsert({
        where: { clientId: this.clientId },
        create: {
          clientId: this.clientId,
          tenantId: this.tenantId,
          branchId: this.branchId,
          storagePath: this.objectPath,
          dataHash: hash,
        },
        update: { storagePath: this.objectPath, dataHash: hash },
      });
    } catch (err) {
      this.logger.error(
        `Backup de sesión ${this.clientId} falló: ${(err as Error).message}`,
      );
    }
  }

  async extract(options: { session: string; path: string }): Promise<void> {
    const data = await this.supabase.downloadPrivateFile(this.objectPath);
    await fs.promises.writeFile(options.path, data);
  }

  async delete(_options: { session: string }): Promise<void> {
    await this.supabase.deletePrivateFile(this.objectPath);
    await this.prisma.whatsappSession
      .delete({ where: { clientId: this.clientId } })
      .catch(() => undefined); // idempotente
  }
}
