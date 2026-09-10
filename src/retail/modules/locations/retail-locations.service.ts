import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import {
  applyBalanceDelta,
  ensureDefaultLocation,
} from '../../shared/retail-stock-locations';
import {
  CreateRetailLocationDto,
  CreateRetailTransferDto,
  RetailLocationCountItemDto,
  SetLocationCountDto,
  UpdateRetailLocationDto,
} from './dto/retail-location.dto';

type Tx = Prisma.TransactionClient;

/**
 * Bodegas / ubicaciones de stock.
 *
 * Todo lo que hay aquí responde a una sola pregunta —"¿dónde está?"— y a
 * ninguna otra. No hay liquidaciones, ni comisiones, ni cuentas por cobrar con
 * los terceros que exhiben mercancía: eso sería consignación, y la decisión
 * explícita fue que esto NO es consignación.
 */
@Injectable()
export class RetailLocationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  private readonly txOptions = { timeout: 20_000 };

  /**
   * Las bodegas de la tienda, con cuánto hay en cada una.
   *
   * Siempre devuelve al menos la principal, creándola si hace falta: una tienda
   * que nunca abrió esta pantalla igual tiene toda su mercancía en algún lado, y
   * ese lado tiene nombre.
   */
  async list(ctx: TenantContext, opts: { includeInactive?: boolean } = {}) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    await this.ensurePrincipal(ctx);

    const locations = await this.prisma.retailStockLocation.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...(opts.includeInactive ? {} : { isActive: true }),
      },
      orderBy: [
        { isDefault: 'desc' },
        { sortOrder: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    // Un solo groupBy para todas: una consulta por bodega convertiría la
    // pantalla de ajustes en N+1 sobre una tabla que crece con el catálogo.
    const totals = await this.prisma.retailStockBalance.groupBy({
      by: ['locationId'],
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      _sum: { qty: true },
      _count: { _all: true },
    });
    const byLocation = new Map(totals.map((row) => [row.locationId, row]));

    return locations.map((location) => ({
      id: location.id,
      name: location.name,
      // El responsable cae al nombre de la bodega: en la principal el
      // responsable es el dueño, y obligarlo a escribirse sería ruido.
      holderName: location.holderName ?? location.name,
      holderNameSet: location.holderName !== null,
      phone: location.phone,
      note: location.note,
      isDefault: location.isDefault,
      isActive: location.isActive,
      sortOrder: location.sortOrder,
      totalUnits: byLocation.get(location.id)?._sum.qty ?? 0,
      productCount: byLocation.get(location.id)?._count._all ?? 0,
      createdAt: location.createdAt,
    }));
  }

  async create(ctx: TenantContext, dto: CreateRetailLocationDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);

    return this.prisma.$transaction(async (tx) => {
      // La principal tiene que existir antes: el conteo inicial sale de ella.
      const principal = await ensureDefaultLocation(tx, ctx);

      const duplicate = await tx.retailStockLocation.findFirst({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          name: { equals: dto.name.trim(), mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new BadRequestException(
          `Ya existe una bodega llamada "${dto.name.trim()}"`,
        );
      }

      const count = await tx.retailStockLocation.count({
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      });

      const location = await tx.retailStockLocation.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          name: dto.name.trim(),
          holderName: dto.holderName?.trim() || null,
          phone: dto.phone?.trim() || null,
          note: dto.note?.trim() || null,
          isDefault: false,
          sortOrder: count,
        },
      });

      if (dto.initialCount?.length) {
        await this.applyCount(tx, ctx, {
          locationId: location.id,
          principalId: principal.id,
          items: dto.initialCount,
          reason: `Conteo inicial · ${location.name}`,
        });
      }

      return location;
    }, this.txOptions);
  }

  async update(ctx: TenantContext, id: string, dto: UpdateRetailLocationDto) {
    const location = await this.findScoped(ctx, id);

    if (location.isDefault && dto.isActive === false) {
      throw new BadRequestException(
        'La bodega principal no se puede desactivar: es donde nace todo el stock',
      );
    }

    if (dto.name !== undefined) {
      const duplicate = await this.prisma.retailStockLocation.findFirst({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          name: { equals: dto.name.trim(), mode: 'insensitive' },
          id: { not: id },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new BadRequestException(
          `Ya existe una bodega llamada "${dto.name.trim()}"`,
        );
      }
    }

    return this.prisma.retailStockLocation.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.holderName !== undefined
          ? { holderName: dto.holderName.trim() || null }
          : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone.trim() || null } : {}),
        ...(dto.note !== undefined ? { note: dto.note.trim() || null } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  /**
   * Desactivar devolviendo la mercancía a la principal.
   *
   * Se DESACTIVA, no se borra: su kardex tiene que sobrevivir para poder mirar
   * después qué se llevó ahí y cuándo. Y lo que quedaba allá vuelve como
   * traslado, no se evapora: si el sitio deja de existir, la mercancía sigue
   * siendo de la tienda y tiene que aparecer en algún lado.
   */
  async deactivate(ctx: TenantContext, id: string) {
    const location = await this.findScoped(ctx, id);
    if (location.isDefault) {
      throw new BadRequestException(
        'La bodega principal no se puede desactivar: es donde nace todo el stock',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const principal = await ensureDefaultLocation(tx, ctx);
      const remaining = await tx.retailStockBalance.findMany({
        where: { locationId: id, qty: { not: 0 } },
      });

      for (const balance of remaining) {
        await this.writeTransferPair(tx, ctx, {
          fromLocationId: id,
          toLocationId: principal.id,
          productId: balance.productId,
          variantId: balance.variantId,
          quantity: balance.qty,
          reference: `close:${id}`,
          note: `Cierre de ${location.name}: la mercancía vuelve a la principal`,
        });
      }

      return tx.retailStockLocation.update({
        where: { id },
        data: { isActive: false },
      });
    }, this.txOptions);
  }

  /**
   * Traslado entre bodegas.
   *
   * NO TOCA VENTAS, NI FINANZAS, NI EL COSTO, NI EL STOCK TOTAL. Salen 3 de un
   * lado y entran 3 al otro: la tienda sigue teniendo las mismas 3. Lo único que
   * cambia es el renglón que dice dónde están.
   */
  async transfer(ctx: TenantContext, dto: CreateRetailTransferDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);

    if (dto.fromLocationId === dto.toLocationId) {
      throw new BadRequestException(
        'El origen y el destino son la misma bodega',
      );
    }
    const from = await this.findScoped(ctx, dto.fromLocationId);
    const to = await this.findScoped(ctx, dto.toLocationId);

    return this.prisma.$transaction(async (tx) => {
      const reference = `transfer:${Date.now()}`;
      const moved: Array<{
        productId: string;
        variantId: string | null;
        quantity: number;
      }> = [];

      for (const line of dto.items) {
        await this.assertProductOfStore(tx, ctx, line.productId);

        // Trasladar más de lo que hay dejaría el origen negativo por un hecho
        // que no ocurrió: no se llevaron 5 si allá solo había 3. Es el ÚNICO
        // punto de todo el módulo que sí bloquea, y puede hacerlo porque un
        // traslado no es una venta: nadie está esperando en el mostrador.
        const available = await tx.retailStockBalance.findFirst({
          where: {
            locationId: from.id,
            productId: line.productId,
            variantId: line.variantId ?? null,
          },
          select: { qty: true },
        });
        if ((available?.qty ?? 0) < line.quantity) {
          const product = await tx.retailProduct.findUnique({
            where: { id: line.productId },
            select: { name: true },
          });
          throw new BadRequestException(
            `No hay ${line.quantity} de "${product?.name ?? line.productId}" en ${from.name}: hay ${available?.qty ?? 0}`,
          );
        }

        await this.writeTransferPair(tx, ctx, {
          fromLocationId: from.id,
          toLocationId: to.id,
          productId: line.productId,
          variantId: line.variantId ?? null,
          quantity: line.quantity,
          reference,
          note: dto.note ?? `Traslado ${from.name} → ${to.name}`,
        });
        moved.push({
          productId: line.productId,
          variantId: line.variantId ?? null,
          quantity: line.quantity,
        });
      }

      return {
        reference,
        fromLocationId: from.id,
        toLocationId: to.id,
        items: moved,
      };
    }, this.txOptions);
  }

  /**
   * Conteo físico en un sitio: fija el saldo que debe quedar allá.
   *
   * Se resuelve como un traslado contra la principal en vez de como un ajuste,
   * porque contar no hace entrar ni salir mercancía de la tienda: si donde Nia
   * hay 5 y el sistema creía 3, esas 2 no aparecieron de la nada — estaban
   * contadas en la principal, que es donde figuraba todo lo que nadie repartió.
   */
  async setCount(
    ctx: TenantContext,
    locationId: string,
    dto: SetLocationCountDto,
  ) {
    const location = await this.findScoped(ctx, locationId);

    return this.prisma.$transaction(async (tx) => {
      const principal = await ensureDefaultLocation(tx, ctx);
      if (principal.id === location.id) {
        throw new BadRequestException(
          'El conteo de la principal se corrige con un ajuste de inventario, no con un traslado contra sí misma',
        );
      }
      return this.applyCount(tx, ctx, {
        locationId: location.id,
        principalId: principal.id,
        items: dto.items,
        reason: `Conteo en ${location.name}`,
      });
    }, this.txOptions);
  }

  /**
   * Qué hay en UNA bodega, producto por producto.
   *
   * Es la vista con la que se hace un conteo físico: se llega al sitio, se abre
   * esto y se compara renglón por renglón con lo que hay en el estante. Por eso
   * incluye las filas en cero de esa bodega —sirven para confirmar que no hay,
   * que es un dato— pero no los productos que nunca han estado ahí.
   */
  async locationStock(ctx: TenantContext, locationId: string) {
    const location = await this.findScoped(ctx, locationId);

    const balances = await this.prisma.retailStockBalance.findMany({
      where: { locationId: location.id },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            trackStock: true,
            deletedAt: true,
            costCOP: true,
            avgCostCOP: true,
            priceCOP: true,
            stock: true,
            category: { select: { name: true } },
          },
        },
        variant: { select: { id: true, label: true } },
      },
    });

    const rows = balances
      .filter((row) => row.product.trackStock && !row.product.deletedAt)
      .map((row) => ({
        productId: row.product.id,
        productName: row.product.name,
        sku: row.product.sku,
        categoryName: row.product.category?.name ?? null,
        variantId: row.variant?.id ?? null,
        variantLabel: row.variant?.label ?? null,
        qty: row.qty,
        minQty: row.minQty,
        // El total de la tienda va al lado del saldo del sitio: sin él, "3 donde
        // Nia" no dice si es todo lo que hay o una parte.
        totalStock: row.product.stock,
        // Al PROMEDIO, como en todo el módulo: el inventario vale lo que se pagó
        // por lo que hay, no lo que costaría volver a comprarlo.
        unitCostCOP: row.product.avgCostCOP ?? row.product.costCOP,
        priceCOP: row.product.priceCOP,
      }))
      .sort(
        (a, b) =>
          b.qty - a.qty || a.productName.localeCompare(b.productName, 'es'),
      );

    return {
      locationId: location.id,
      locationName: location.name,
      isDefault: location.isDefault,
      totalUnits: rows.reduce((sum, row) => sum + row.qty, 0),
      valueAtCostCOP: rows.reduce(
        (sum, row) => sum + row.qty * row.unitCostCOP,
        0,
      ),
      valueAtPriceCOP: rows.reduce(
        (sum, row) => sum + row.qty * row.priceCOP,
        0,
      ),
      rows,
    };
  }

  /** Dónde está cada unidad de un producto. */
  async productBreakdown(ctx: TenantContext, productId: string) {
    await this.tenantHelper.assertScopedRecord(
      'retailProduct',
      ctx,
      productId,
      'Product',
    );
    await this.ensurePrincipal(ctx);

    const [product, balances] = await Promise.all([
      this.prisma.retailProduct.findUniqueOrThrow({
        where: { id: productId },
        select: {
          id: true,
          name: true,
          stock: true,
          trackStock: true,
          variants: {
            select: { id: true, label: true, stock: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      }),
      this.prisma.retailStockBalance.findMany({
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId, productId },
        include: {
          location: {
            select: { id: true, name: true, isDefault: true, isActive: true },
          },
          variant: { select: { id: true, label: true } },
        },
      }),
    ]);

    const byLocation = new Map<
      string,
      {
        locationId: string;
        locationName: string;
        isDefault: boolean;
        isActive: boolean;
        qty: number;
        variants: Array<{ variantId: string; label: string; qty: number }>;
      }
    >();

    for (const row of balances) {
      const entry = byLocation.get(row.location.id) ?? {
        locationId: row.location.id,
        locationName: row.location.name,
        isDefault: row.location.isDefault,
        isActive: row.location.isActive,
        qty: 0,
        variants: [],
      };
      entry.qty += row.qty;
      if (row.variant) {
        entry.variants.push({
          variantId: row.variant.id,
          label: row.variant.label,
          qty: row.qty,
        });
      }
      byLocation.set(row.location.id, entry);
    }

    const locations = [...byLocation.values()].sort(
      (a, b) => Number(b.isDefault) - Number(a.isDefault) || b.qty - a.qty,
    );

    // El total manda: si los saldos no lo alcanzan, la diferencia se reporta
    // como "sin ubicar" en vez de callarla. Callarla haría que la pantalla
    // mostrara menos unidades de las que la tienda tiene, y el dueño creería que
    // le faltan.
    const located = locations.reduce((sum, row) => sum + row.qty, 0);

    return {
      productId: product.id,
      productName: product.name,
      totalStock: product.stock,
      trackStock: product.trackStock,
      locatedUnits: located,
      unlocatedUnits: product.stock - located,
      locations,
    };
  }

  // ─── Interno ──────────────────────────────────────────────────────────────

  /**
   * La principal existe, sin abrir una transacción cuando ya está.
   *
   * Esto lo llaman las dos LECTURAS de la pantalla, así que corre en cada carga.
   * `ensureDefaultLocation` abre transacción para poder crearla en el mismo
   * commit que la usa; aquí no hay nada que escribir el 99.99% de las veces, y
   * pagar una transacción por cada apertura del inventario para releer una fila
   * que siempre está no se justifica.
   */
  private async ensurePrincipal(ctx: TenantContext) {
    const existing = await this.prisma.retailStockLocation.findFirst({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        isDefault: true,
      },
      select: { id: true },
    });
    if (existing) return existing.id;

    const created = await this.prisma.$transaction(
      (tx) => ensureDefaultLocation(tx, ctx),
      this.txOptions,
    );
    return created.id;
  }

  private async findScoped(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const location = await this.prisma.retailStockLocation.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!location) throw new NotFoundException(`Bodega ${id} no encontrada`);
    return location;
  }

  private async assertProductOfStore(
    tx: Tx,
    ctx: TenantContext,
    productId: string,
  ) {
    const product = await tx.retailProduct.findFirst({
      where: { id: productId, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { id: true },
    });
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }
  }

  /**
   * Las DOS caras de un traslado, en el mismo commit.
   *
   * Dos filas y no una: así el kardex de cada bodega cuadra por sí solo al
   * filtrarlo, sin tener que mirar la columna de destino para saber si esa fila
   * le sumaba o le restaba. Se emparejan por `reference`.
   *
   * `stockAfter` es el total del producto, que en un traslado NO CAMBIA. Que las
   * dos filas muestren el mismo número es la prueba de que la tienda sigue
   * teniendo lo mismo.
   */
  private async writeTransferPair(
    tx: Tx,
    ctx: TenantContext,
    args: {
      fromLocationId: string;
      toLocationId: string;
      productId: string;
      variantId: string | null;
      quantity: number;
      reference: string;
      note: string;
    },
  ) {
    const product = await tx.retailProduct.findUniqueOrThrow({
      where: { id: args.productId },
      select: { stock: true },
    });

    await applyBalanceDelta(
      tx,
      ctx,
      {
        locationId: args.fromLocationId,
        productId: args.productId,
        variantId: args.variantId,
      },
      -args.quantity,
    );
    await applyBalanceDelta(
      tx,
      ctx,
      {
        locationId: args.toLocationId,
        productId: args.productId,
        variantId: args.variantId,
      },
      args.quantity,
    );

    const base = {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      productId: args.productId,
      variantId: args.variantId,
      type: 'TRANSFER' as const,
      stockAfter: product.stock,
      reason: args.note,
      reference: args.reference,
      userId: ctx.userId,
    };

    await tx.retailStockMovement.createMany({
      data: [
        {
          ...base,
          quantity: -args.quantity,
          locationId: args.fromLocationId,
          toLocationId: args.toLocationId,
        },
        {
          ...base,
          quantity: args.quantity,
          locationId: args.toLocationId,
          toLocationId: args.fromLocationId,
        },
      ],
    });
  }

  /** Deja el saldo de un sitio en el número contado, moviendo la diferencia contra la principal. */
  private async applyCount(
    tx: Tx,
    ctx: TenantContext,
    args: {
      locationId: string;
      principalId: string;
      items: RetailLocationCountItemDto[];
      reason: string;
    },
  ) {
    const applied: Array<{
      productId: string;
      variantId: string | null;
      delta: number;
    }> = [];

    for (const item of args.items) {
      await this.assertProductOfStore(tx, ctx, item.productId);

      const current = await tx.retailStockBalance.findFirst({
        where: {
          locationId: args.locationId,
          productId: item.productId,
          variantId: item.variantId ?? null,
        },
        select: { qty: true },
      });
      const delta = item.quantity - (current?.qty ?? 0);
      if (delta === 0) continue;

      // Contar de más allá significa que esas unidades salen de la principal, y
      // contar de menos que vuelven a ella. En los dos sentidos es el mismo par
      // de filas, solo cambia la dirección.
      await this.writeTransferPair(tx, ctx, {
        fromLocationId: delta > 0 ? args.principalId : args.locationId,
        toLocationId: delta > 0 ? args.locationId : args.principalId,
        productId: item.productId,
        variantId: item.variantId ?? null,
        quantity: Math.abs(delta),
        reference: `count:${args.locationId}:${Date.now()}`,
        note: args.reason,
      });
      applied.push({
        productId: item.productId,
        variantId: item.variantId ?? null,
        delta,
      });
    }

    return { locationId: args.locationId, applied };
  }
}
