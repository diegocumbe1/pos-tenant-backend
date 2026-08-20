import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RetailPurchaseItem, RetailPurchaseStatus } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import {
  CreateRetailPurchaseItemDto,
  ReceiveRetailPurchaseItemDto,
  UpdateRetailPurchaseItemDto,
} from './dto/retail-purchases.dto';

/** Estados que siguen "vivos" en la lista: lo que todavía hay que atender. */
const OPEN_STATUSES: RetailPurchaseStatus[] = ['PENDING', 'ORDERED'];

/**
 * Lista de pedidos al proveedor: el paso previo al catálogo y al inventario.
 *
 * Funciona como una lista de tareas — se apunta, se marca "pedido" y se marca
 * "recibido" — y cada marca deja su fecha, que es lo que permite ver qué lleva
 * días sin pedirse o sin llegar. El inventario solo se toca al recibir, y
 * siempre a través del kardex, para que stock y movimientos nunca divergan.
 */
@Injectable()
export class RetailPurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  async list(
    ctx: TenantContext,
    filters: { status?: RetailPurchaseStatus; open?: boolean } = {},
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const items = await this.prisma.retailPurchaseItem.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.open ? { status: { in: OPEN_STATUSES } } : {}),
      },
      // Lo urgente arriba y, dentro de eso, lo más viejo primero: lo que lleva
      // más tiempo apuntado es lo que más urge resolver.
      orderBy: [{ isUrgent: 'desc' }, { createdAt: 'asc' }],
      include: {
        product: { select: { id: true, name: true, sku: true, stock: true } },
      },
    });
    return items.map((item) => this.toDto(item));
  }

  /** Contadores para la cabecera: qué falta pedir, qué está en camino. */
  async getSummary(ctx: TenantContext) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const grouped = await this.prisma.retailPurchaseItem.groupBy({
      by: ['status'],
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
      _count: { _all: true },
      _sum: { quantity: true },
    });

    const countOf = (status: RetailPurchaseStatus) =>
      grouped.find((row) => row.status === status)?._count._all ?? 0;

    // Valor estimado de lo que falta comprar: sirve para saber cuánta plata hay
    // que separar antes de ir donde el proveedor.
    const open = await this.prisma.retailPurchaseItem.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
        status: { in: OPEN_STATUSES },
      },
      select: { quantity: true, estimatedCostCOP: true },
    });

    return {
      pendingCount: countOf('PENDING'),
      orderedCount: countOf('ORDERED'),
      receivedCount: countOf('RECEIVED'),
      cancelledCount: countOf('CANCELLED'),
      openCount: countOf('PENDING') + countOf('ORDERED'),
      estimatedOpenCostCOP: open.reduce(
        (sum, item) => sum + (item.estimatedCostCOP ?? 0) * item.quantity,
        0,
      ),
    };
  }

  async create(ctx: TenantContext, dto: CreateRetailPurchaseItemDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    if (dto.productId) {
      await this.tenantHelper.assertScopedRecord(
        'retailProduct',
        ctx,
        dto.productId,
        'Product',
      );
    }

    const item = await this.prisma.retailPurchaseItem.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        productId: dto.productId ?? null,
        name: dto.name.trim(),
        quantity: dto.quantity ?? 1,
        unit: dto.unit?.trim() || null,
        supplier: dto.supplier?.trim() || null,
        estimatedCostCOP: dto.estimatedCostCOP,
        note: dto.note?.trim() || null,
        isUrgent: dto.isUrgent ?? false,
        createdById: ctx.userId,
      },
      include: {
        product: { select: { id: true, name: true, sku: true, stock: true } },
      },
    });
    return this.toDto(item);
  }

  async update(
    ctx: TenantContext,
    id: string,
    dto: UpdateRetailPurchaseItemDto,
  ) {
    await this.assertOwnItem(ctx, id);
    if (dto.productId) {
      await this.tenantHelper.assertScopedRecord(
        'retailProduct',
        ctx,
        dto.productId,
        'Product',
      );
    }

    const item = await this.prisma.retailPurchaseItem.update({
      where: { id },
      data: {
        productId: dto.productId,
        name: dto.name?.trim(),
        quantity: dto.quantity,
        unit: dto.unit === undefined ? undefined : dto.unit.trim() || null,
        supplier:
          dto.supplier === undefined ? undefined : dto.supplier.trim() || null,
        estimatedCostCOP: dto.estimatedCostCOP,
        note: dto.note === undefined ? undefined : dto.note.trim() || null,
        isUrgent: dto.isUrgent,
        // Prisma ya distingue null (desenlazar) de undefined (no tocar).
        expenseId: dto.expenseId,
        shippingExpenseId: dto.shippingExpenseId,
      },
      include: {
        product: { select: { id: true, name: true, sku: true, stock: true } },
      },
    });
    return this.toDto(item);
  }

  /**
   * Marca (o desmarca) el ítem como pedido al proveedor. Desmarcar borra la
   * fecha: si se apuntó por error, la lista no debe mentir diciendo que ya se
   * pidió.
   */
  async setOrdered(ctx: TenantContext, id: string, ordered: boolean) {
    const current = await this.assertOwnItem(ctx, id);
    if (current.status === 'RECEIVED') {
      throw new BadRequestException(
        'El ítem ya llegó: no se puede volver a marcar como pedido',
      );
    }

    const item = await this.prisma.retailPurchaseItem.update({
      where: { id },
      data: ordered
        ? {
            status: 'ORDERED',
            orderedAt: new Date(),
            orderedById: ctx.userId,
          }
        : { status: 'PENDING', orderedAt: null, orderedById: null },
      include: {
        product: { select: { id: true, name: true, sku: true, stock: true } },
      },
    });
    return this.toDto(item);
  }

  /**
   * Marca el ítem como recibido y, si está enlazado a un producto que controla
   * stock, deja la entrada en el kardex en el mismo commit. Ese es el puente
   * con el inventario: la lista no mueve existencias por su cuenta.
   */
  async receive(
    ctx: TenantContext,
    id: string,
    dto: ReceiveRetailPurchaseItemDto,
  ) {
    const current = await this.assertOwnItem(ctx, id);
    if (current.status === 'RECEIVED') {
      throw new BadRequestException('El ítem ya estaba marcado como recibido');
    }

    const received = dto.quantity ?? current.quantity;
    const unitCost = dto.unitCostCOP ?? current.estimatedCostCOP ?? undefined;

    const item = await this.prisma.$transaction(async (tx) => {
      let stockMovementId: string | null = null;

      const product = current.productId
        ? await tx.retailProduct.findUnique({
            where: { id: current.productId },
            select: { id: true, stock: true, trackStock: true },
          })
        : null;

      const touchesInventory =
        dto.addToInventory !== false &&
        received > 0 &&
        product !== null &&
        product.trackStock;

      if (touchesInventory) {
        const stockAfter = product.stock + received;
        const movement = await tx.retailStockMovement.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            productId: product.id,
            type: 'PURCHASE',
            quantity: received,
            stockAfter,
            unitCostCOP: unitCost,
            reason: `Pedido recibido: ${current.name}`,
            reference: dto.reference ?? `purchase:${current.id}`,
            userId: ctx.userId,
          },
        });
        stockMovementId = movement.id;

        await tx.retailProduct.update({
          where: { id: product.id },
          data: {
            stock: stockAfter,
            // El costo real de la compra pasa a ser el costo de referencia.
            ...(unitCost !== undefined ? { costCOP: unitCost } : {}),
          },
        });
      }

      return tx.retailPurchaseItem.update({
        where: { id },
        data: {
          status: 'RECEIVED',
          receivedAt: new Date(),
          receivedById: ctx.userId,
          // Recibir algo que nunca se marcó como pedido igual deja la fecha:
          // en la práctica se compra de una y se anota después.
          orderedAt: current.orderedAt ?? new Date(),
          orderedById: current.orderedById ?? ctx.userId,
          quantity: received,
          ...(dto.unitCostCOP !== undefined
            ? { estimatedCostCOP: dto.unitCostCOP }
            : {}),
          stockMovementId,
        },
        include: {
          product: { select: { id: true, name: true, sku: true, stock: true } },
        },
      });
    }, this.txOptions);

    return this.toDto(item);
  }

  /** Ya no se va a pedir. Queda en la lista como registro, no se borra. */
  async cancel(ctx: TenantContext, id: string) {
    const current = await this.assertOwnItem(ctx, id);
    if (current.status === 'RECEIVED') {
      throw new BadRequestException(
        'El ítem ya llegó: para revertirlo, ajusta el inventario',
      );
    }
    const item = await this.prisma.retailPurchaseItem.update({
      where: { id },
      data: { status: 'CANCELLED' },
      include: {
        product: { select: { id: true, name: true, sku: true, stock: true } },
      },
    });
    return this.toDto(item);
  }

  /** Vuelve a "por pedir" un ítem cancelado. */
  async reopen(ctx: TenantContext, id: string) {
    const current = await this.assertOwnItem(ctx, id);
    if (current.status !== 'CANCELLED') {
      throw new BadRequestException('Solo se puede reabrir un ítem cancelado');
    }
    const item = await this.prisma.retailPurchaseItem.update({
      where: { id },
      data: { status: 'PENDING', orderedAt: null, orderedById: null },
      include: {
        product: { select: { id: true, name: true, sku: true, stock: true } },
      },
    });
    return this.toDto(item);
  }

  /** Soft-delete: sacar de la lista sin perder el histórico de lo recibido. */
  async remove(ctx: TenantContext, id: string) {
    await this.assertOwnItem(ctx, id);
    await this.prisma.retailPurchaseItem.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  private async assertOwnItem(
    ctx: TenantContext,
    id: string,
  ): Promise<RetailPurchaseItem> {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const item = await this.prisma.retailPurchaseItem.findUnique({
      where: { id },
    });
    if (
      !item ||
      item.deletedAt ||
      item.tenantId !== ctx.tenantId ||
      item.branchId !== ctx.branchId
    ) {
      throw new NotFoundException(`Purchase item ${id} not found`);
    }
    return item;
  }

  private toDto(
    item: RetailPurchaseItem & {
      product?: {
        id: string;
        name: string;
        sku: string | null;
        stock: number;
      } | null;
    },
  ) {
    return {
      id: item.id,
      productId: item.productId,
      productName: item.product?.name ?? null,
      productSku: item.product?.sku ?? null,
      productStock: item.product?.stock ?? null,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      supplier: item.supplier,
      estimatedCostCOP: item.estimatedCostCOP,
      // Lo que costaría la línea completa; el listado no debería multiplicar.
      estimatedTotalCOP:
        item.estimatedCostCOP !== null
          ? item.estimatedCostCOP * item.quantity
          : null,
      note: item.note,
      status: item.status,
      isUrgent: item.isUrgent,
      createdAt: item.createdAt,
      orderedAt: item.orderedAt,
      receivedAt: item.receivedAt,
      createdById: item.createdById,
      orderedById: item.orderedById,
      receivedById: item.receivedById,
      // Deja ver si la entrada al inventario efectivamente se generó.
      stockMovementId: item.stockMovementId,
      // …y si la plata que salió quedó registrada en Finanzas. null = falta.
      expenseId: item.expenseId,
      shippingExpenseId: item.shippingExpenseId,
    };
  }

  private readonly txOptions = { timeout: 15_000 };
}
