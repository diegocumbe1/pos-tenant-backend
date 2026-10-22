import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { addCalendarDaysCO, calendarDayCO } from '../../../common/date.util';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import {
  BirthdayWindow,
  CreateRetailCustomerDto,
  UpdateRetailCustomerDto,
} from './dto/retail-customer.dto';

/**
 * Cómo llega un campo de texto opcional en un PATCH:
 *
 *   undefined → no se manda: se deja como estaba.
 *   ''        → se manda vacío: se BORRA, y se guarda NULL.
 *   valor     → se guarda.
 *
 * La cadena vacía tiene que borrar de verdad. Sin esto no había forma de quitar
 * un teléfono mal digitado —mandarlo vacío lo dejaba igual— y la única salida
 * era borrar al cliente y crearlo de nuevo, perdiendo su historial de compras.
 *
 * Y borra a NULL, no a '': un teléfono guardado como cadena vacía existe pero no
 * sirve, y toda pantalla que hace `phone ?? '—'` mostraría un hueco en vez de un
 * guion. "No tengo el dato" en base de datos se escribe NULL.
 */
function patchText(
  value: string | undefined,
  normalize: (value: string) => string = (raw) => raw,
): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : normalize(trimmed);
}

/** Días que tiene cada mes, contando el 29 de febrero: hay quien nació ese día. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Cumpleaños tal como queda guardado después de aplicar el dto.
 *
 * Día y mes van juntos o no van: "nació en marzo" sin día no sirve para
 * felicitar a nadie, y un día sin mes no es una fecha. El año sí es suelto.
 * Se valida sobre el resultado final (lo guardado + lo que llega) porque un
 * PATCH puede mandar solo el día.
 */
function resolveBirthday(
  dto: {
    birthMonth?: number | null;
    birthDay?: number | null;
    birthYear?: number | null;
  },
  current?: {
    birthMonth: number | null;
    birthDay: number | null;
    birthYear: number | null;
  },
) {
  const month =
    dto.birthMonth !== undefined
      ? dto.birthMonth
      : (current?.birthMonth ?? null);
  const day =
    dto.birthDay !== undefined ? dto.birthDay : (current?.birthDay ?? null);
  const year =
    dto.birthYear !== undefined ? dto.birthYear : (current?.birthYear ?? null);

  if ((month === null) !== (day === null)) {
    throw new BadRequestException(
      'El cumpleaños necesita día y mes; el año es opcional',
    );
  }
  if (month !== null && day !== null && day > DAYS_IN_MONTH[month - 1]) {
    throw new BadRequestException('Esa fecha de cumpleaños no existe');
  }
  if (year !== null && month === null) {
    throw new BadRequestException('Falta el día y el mes del cumpleaños');
  }
  return { birthMonth: month, birthDay: day, birthYear: year };
}

/**
 * Pares (mes, día) que caen dentro de la ventana, contados en hora Colombia.
 *
 * La semana se arma día por día y no como un rango de mes: del 28 de diciembre
 * en adelante cruza al año siguiente, y un "mes entre 12 y 1" no existe.
 */
function birthdayWhere(
  window: BirthdayWindow,
): Prisma.RetailCustomerWhereInput {
  const today = calendarDayCO(new Date());
  const [, month] = today.split('-').map(Number);
  if (window === 'month') return { birthMonth: month };

  const days = window === 'today' ? 1 : 7;
  const pairs = Array.from({ length: days }, (_, offset) => {
    const [, m, d] = addCalendarDaysCO(today, offset).split('-').map(Number);
    return { birthMonth: m, birthDay: d };
  });
  return { OR: pairs };
}

@Injectable()
export class RetailCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  async listCustomers(
    ctx: TenantContext,
    search?: string,
    birthdays?: BirthdayWindow,
    birthMonth?: number,
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const birthdayFilter = birthMonth
      ? { birthMonth }
      : birthdays
        ? birthdayWhere(birthdays)
        : null;
    return this.prisma.retailCustomer.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
        // AND y no spread: la búsqueda y la ventana de cumpleaños traen cada
        // una su propio OR, y con spread el segundo pisaría al primero.
        AND: birthdayFilter ? [birthdayFilter] : [],
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search } },
                { documentId: { contains: search } },
              ],
            }
          : {}),
      },
      // Con el filtro de cumpleaños el orden útil es el del calendario: quién
      // cumple primero.
      orderBy: birthdayFilter
        ? [{ birthMonth: 'asc' }, { birthDay: 'asc' }, { name: 'asc' }]
        : [{ lastPurchaseAt: 'desc' }, { name: 'asc' }],
      take: 200,
    });
  }

  async createCustomer(ctx: TenantContext, dto: CreateRetailCustomerDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const birthday = resolveBirthday(dto);
    try {
      return await this.prisma.retailCustomer.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          name: dto.name.trim(),
          phone: dto.phone?.replace(/\s/g, '') || null,
          email: dto.email,
          documentId: dto.documentId,
          address: dto.address?.trim() || null,
          city: dto.city?.trim() || null,
          notes: dto.notes,
          ...birthday,
        },
      });
    } catch (error) {
      throw this.mapUniqueError(error, dto.phone);
    }
  }

  async updateCustomer(
    ctx: TenantContext,
    id: string,
    dto: UpdateRetailCustomerDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'retailCustomer',
      ctx,
      id,
      'Customer',
    );
    const current = await this.prisma.retailCustomer.findUniqueOrThrow({
      where: { id },
      select: { birthMonth: true, birthDay: true, birthYear: true },
    });
    const birthday = resolveBirthday(dto, current);
    try {
      return await this.prisma.retailCustomer.update({
        where: { id },
        data: {
          ...birthday,
          name: dto.name?.trim(),
          phone: patchText(dto.phone, (value) => value.replace(/\s/g, '')),
          email: patchText(dto.email),
          documentId: patchText(dto.documentId),
          address: patchText(dto.address),
          city: patchText(dto.city),
          notes: patchText(dto.notes),
        },
      });
    } catch (error) {
      throw this.mapUniqueError(error, dto.phone);
    }
  }

  async deleteCustomer(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'retailCustomer',
      ctx,
      id,
      'Customer',
    );
    await this.prisma.retailCustomer.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  /** Historial de compras de un cliente (ficha). */
  async getCustomerSales(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'retailCustomer',
      ctx,
      id,
      'Customer',
    );
    return this.prisma.retailSale.findMany({
      where: { customerId: id, tenantId: ctx.tenantId },
      orderBy: { soldAt: 'desc' },
      take: 100,
      include: { items: true },
    });
  }

  private mapUniqueError(error: unknown, phone?: string): Error {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        `Ya existe un cliente con el teléfono ${phone ?? ''}`.trim(),
      );
    }
    return error as Error;
  }
}
