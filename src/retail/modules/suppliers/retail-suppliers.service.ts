import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import {
  CreateRetailSupplierDto,
  CreateSupplierLedgerEntryDto,
  UpdateRetailSupplierDto,
} from './dto/retail-supplier.dto';

/**
 * Líneas que dejaron una diferencia sin resolver: son las que mantienen viva la
 * cuenta en mercancía, que es distinta de la cuenta en plata.
 */
const OPEN_VARIANCE_WHERE = {
  deletedAt: null,
  status: 'RECEIVED' as const,
  varianceResolution: 'PENDING' as const,
};

/**
 * [VERTICAL_RETAIL] Proveedores y su cuenta corriente.
 *
 * DOS SALDOS, NO UNO. Con un proveedor se deben dos cosas distintas y no se
 * cruzan: plata y mercancía. En el caso del pedido del 20/08 faltaron 12 splash
 * y sobraron 12 perfumes; en pesos se compensan casi exacto y en producto no se
 * compensan nada — siguen faltando 12 splash. Por eso el saldo de plata sale del
 * libro y el de mercancía sale de las líneas con diferencia abierta, y la
 * pantalla los muestra separados.
 *
 * EL SIGNO ES SIEMPRE DESDE LA TIENDA. Positivo = le debo al proveedor.
 * Negativo = el proveedor me debe. Un solo eje, porque la pregunta del negocio
 * es una sola y con dos columnas de debe/haber habría que restarlas cada vez.
 */
@Injectable()
export class RetailSuppliersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  async list(ctx: TenantContext, includeBalance = true) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const suppliers = await this.prisma.retailSupplier.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
      orderBy: { name: 'asc' },
    });
    if (!includeBalance) return suppliers.map((s) => this.toDto(s));

    // Dos agregados en vez de N consultas: la lista de proveedores se pinta
    // entera y pedir el saldo uno por uno la volvería lenta con 20 fichas.
    const [balances, variances] = await Promise.all([
      this.prisma.retailSupplierLedgerEntry.groupBy({
        by: ['supplierId'],
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
        _sum: { amountCOP: true },
      }),
      this.prisma.retailPurchaseItem.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          supplierId: { not: null },
          ...OPEN_VARIANCE_WHERE,
        },
        select: {
          supplierId: true,
          quantity: true,
          receivedQuantity: true,
        },
      }),
    ]);

    const balanceBySupplier = new Map(
      balances.map((row) => [row.supplierId, row._sum.amountCOP ?? 0]),
    );
    const goodsBySupplier = new Map<
      string,
      { owedToUs: number; owedByUs: number }
    >();
    for (const line of variances) {
      if (!line.supplierId) continue;
      const diff = (line.receivedQuantity ?? 0) - line.quantity;
      const bucket = goodsBySupplier.get(line.supplierId) ?? {
        owedToUs: 0,
        owedByUs: 0,
      };
      if (diff < 0) bucket.owedToUs += Math.abs(diff);
      else bucket.owedByUs += diff;
      goodsBySupplier.set(line.supplierId, bucket);
    }

    return suppliers.map((supplier) => ({
      ...this.toDto(supplier),
      ...this.balanceShape(
        balanceBySupplier.get(supplier.id) ?? 0,
        goodsBySupplier.get(supplier.id),
      ),
    }));
  }

  async get(ctx: TenantContext, id: string) {
    await this.assertOwn(ctx, id);
    const supplier = await this.prisma.retailSupplier.findUniqueOrThrow({
      where: { id },
    });
    const [balance, variances] = await Promise.all([
      this.prisma.retailSupplierLedgerEntry.aggregate({
        where: { supplierId: id },
        _sum: { amountCOP: true },
      }),
      this.prisma.retailPurchaseItem.findMany({
        where: { supplierId: id, ...OPEN_VARIANCE_WHERE },
        select: {
          id: true,
          name: true,
          quantity: true,
          receivedQuantity: true,
          receivedUnitCostCOP: true,
          estimatedCostCOP: true,
          receivedAt: true,
          varianceNote: true,
        },
      }),
    ]);

    const goods = { owedToUs: 0, owedByUs: 0 };
    for (const line of variances) {
      const diff = (line.receivedQuantity ?? 0) - line.quantity;
      if (diff < 0) goods.owedToUs += Math.abs(diff);
      else goods.owedByUs += diff;
    }

    return {
      ...this.toDto(supplier),
      ...this.balanceShape(balance._sum.amountCOP ?? 0, goods),
      /** Las líneas concretas que sostienen el saldo en mercancía. */
      openVariances: variances.map((line) => ({
        purchaseItemId: line.id,
        name: line.name,
        quantity: line.quantity,
        receivedQuantity: line.receivedQuantity,
        varianceQty: (line.receivedQuantity ?? 0) - line.quantity,
        unitCostCOP: line.receivedUnitCostCOP ?? line.estimatedCostCOP,
        receivedAt: line.receivedAt,
        note: line.varianceNote,
      })),
    };
  }

  /** El extracto: cada movimiento y el saldo que iba quedando. */
  async listLedger(ctx: TenantContext, id: string, limit = 100) {
    await this.assertOwn(ctx, id);
    const entries = await this.prisma.retailSupplierLedgerEntry.findMany({
      where: { supplierId: id },
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(limit, 500),
      include: {
        purchaseItem: { select: { id: true, name: true } },
      },
    });

    // El saldo corriente se calcula acá y no en el frontend: es la columna que
    // hace legible un extracto, y tiene que dar lo mismo en toda pantalla que lo
    // muestre. Va en orden ascendente por eso — un extracto se lee hacia abajo.
    let running = 0;
    return entries.map((entry) => {
      running += entry.amountCOP;
      return {
        id: entry.id,
        kind: entry.kind,
        amountCOP: entry.amountCOP,
        balanceAfterCOP: running,
        purchaseItemId: entry.purchaseItemId,
        purchaseItemName: entry.purchaseItem?.name ?? null,
        expenseId: entry.expenseId,
        note: entry.note,
        occurredAt: entry.occurredAt,
      };
    });
  }

  async create(ctx: TenantContext, dto: CreateRetailSupplierDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const name = dto.name.trim();
    // Se busca primero por nombre normalizado: el punto de la ficha es que no
    // haya dos cuentas del mismo proveedor, y el índice único es sensible a
    // mayúsculas. Si ya existe —incluso borrada— se reusa.
    const existing = await this.prisma.retailSupplier.findFirst({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name: { equals: name, mode: 'insensitive' },
      },
    });
    if (existing) {
      const revived = await this.prisma.retailSupplier.update({
        where: { id: existing.id },
        data: { deletedAt: null, ...this.detailsData(dto) },
      });
      return this.toDto(revived);
    }

    const supplier = await this.prisma.retailSupplier.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name,
        ...this.detailsData(dto),
      },
    });
    return this.toDto(supplier);
  }

  async update(ctx: TenantContext, id: string, dto: UpdateRetailSupplierDto) {
    await this.assertOwn(ctx, id);
    const supplier = await this.prisma.retailSupplier.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...this.detailsData(dto),
      },
    });
    return this.toDto(supplier);
  }

  /**
   * Soft-delete. No se borra de verdad porque los pedidos y el libro le apuntan:
   * el histórico de a quién se le compró tiene que sobrevivir a que se deje de
   * trabajar con alguien.
   */
  async remove(ctx: TenantContext, id: string) {
    await this.assertOwn(ctx, id);
    const balance = await this.prisma.retailSupplierLedgerEntry.aggregate({
      where: { supplierId: id },
      _sum: { amountCOP: true },
    });
    if ((balance._sum.amountCOP ?? 0) !== 0) {
      throw new BadRequestException(
        'Este proveedor tiene saldo pendiente: sáldalo antes de archivarlo',
      );
    }
    await this.prisma.retailSupplier.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  /** Movimiento a mano: nota crédito, o el saldo que se traía de antes. */
  async addLedgerEntry(
    ctx: TenantContext,
    id: string,
    dto: CreateSupplierLedgerEntryDto,
  ) {
    await this.assertOwn(ctx, id);
    if (dto.amountCOP === 0) {
      throw new BadRequestException('Un movimiento en cero no mueve el saldo');
    }
    await this.prisma.retailSupplierLedgerEntry.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        supplierId: id,
        kind: dto.kind,
        amountCOP: dto.amountCOP,
        purchaseItemId: dto.purchaseItemId ?? null,
        note: dto.note?.trim() || null,
        occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : new Date(),
        userId: ctx.userId,
      },
    });
    return this.get(ctx, id);
  }

  // ─── Interno ───────────────────────────────────────────────────────────────

  private assertOwn(ctx: TenantContext, id: string) {
    return this.tenantHelper.assertScopedRecord(
      'retailSupplier',
      ctx,
      id,
      'Supplier',
    );
  }

  private detailsData(dto: UpdateRetailSupplierDto) {
    return {
      ...(dto.contactName !== undefined
        ? { contactName: dto.contactName.trim() || null }
        : {}),
      ...(dto.phone !== undefined ? { phone: dto.phone.trim() || null } : {}),
      ...(dto.email !== undefined ? { email: dto.email.trim() || null } : {}),
      ...(dto.city !== undefined ? { city: dto.city.trim() || null } : {}),
      ...(dto.note !== undefined ? { note: dto.note.trim() || null } : {}),
    };
  }

  /**
   * La forma en que viaja el saldo. Los tres campos son el mismo número visto de
   * tres maneras porque cada pantalla necesita una distinta y calcular el signo
   * en cada una es donde se cuelan los errores.
   */
  private balanceShape(
    balanceCOP: number,
    goods?: { owedToUs: number; owedByUs: number },
  ) {
    return {
      /** Positivo = le debo. Negativo = me debe. Cero = a paz y salvo. */
      balanceCOP,
      /** Lo que le debo, o 0. */
      owedToSupplierCOP: Math.max(0, balanceCOP),
      /** Lo que me debe, o 0. */
      owedBySupplierCOP: Math.max(0, -balanceCOP),
      /**
       * Unidades que quedaron descuadradas y sin resolver. No se cruzan con la
       * plata ni entre sí: 12 unidades que faltan de un producto no se saldan
       * con 12 que sobraron de otro.
       */
      unitsOwedToUs: goods?.owedToUs ?? 0,
      unitsOwedByUs: goods?.owedByUs ?? 0,
    };
  }

  private toDto(supplier: Prisma.RetailSupplierGetPayload<object>) {
    return {
      id: supplier.id,
      name: supplier.name,
      contactName: supplier.contactName,
      phone: supplier.phone,
      email: supplier.email,
      city: supplier.city,
      note: supplier.note,
      createdAt: supplier.createdAt,
      updatedAt: supplier.updatedAt,
    };
  }
}
