import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { CancelReservationDto } from './dto/cancel-reservation.dto';
import {
  TABLE_UPDATED,
  TableUpdatedEvent,
} from '../../../realtime/realtime.events';

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async findAll(ctx: TenantContext, status?: string, upcoming?: boolean) {
    const reservations = await this.prisma.reservation.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...(status ? { status } : {}),
        ...(upcoming ? { scheduledAt: { gte: new Date() } } : {}),
      },
      orderBy: { scheduledAt: 'asc' },
    });

    return { reservations: reservations.map((r) => this.map(r)) };
  }

  async create(ctx: TenantContext, dto: CreateReservationDto) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id: dto.tableId, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!table) throw new NotFoundException(`Table ${dto.tableId} not found`);

    const reservation = await this.prisma.reservation.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        tableId: dto.tableId,
        guestName: dto.guestName,
        guestPhone: dto.guestPhone,
        partySize: dto.partySize,
        scheduledAt: new Date(dto.scheduledAt),
        scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : null,
        occasion: dto.occasion,
        occasionNote: dto.occasionNote,
        notes: dto.notes,
        status: 'ACTIVE',
      },
    });

    await this.prisma.restaurantTable.update({
      where: { id: dto.tableId },
      data: { status: 'RESERVED' },
    });

    this.events.emit(TABLE_UPDATED, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      tableId: dto.tableId,
      reason: 'reservation-created',
    } satisfies TableUpdatedEvent);

    return this.map(reservation);
  }

  async update(ctx: TenantContext, id: string, dto: UpdateReservationDto) {
    const existing = await this.assertActive(ctx, id);

    const updated = await this.prisma.reservation.update({
      where: { id },
      data: {
        ...(dto.tableId !== undefined ? { tableId: dto.tableId } : {}),
        ...(dto.guestName !== undefined ? { guestName: dto.guestName } : {}),
        ...(dto.guestPhone !== undefined ? { guestPhone: dto.guestPhone } : {}),
        ...(dto.partySize !== undefined ? { partySize: dto.partySize } : {}),
        ...(dto.scheduledAt !== undefined
          ? { scheduledAt: new Date(dto.scheduledAt) }
          : {}),
        ...(dto.scheduledEnd !== undefined
          ? { scheduledEnd: dto.scheduledEnd ? new Date(dto.scheduledEnd) : null }
          : {}),
        ...(dto.occasion !== undefined ? { occasion: dto.occasion } : {}),
        ...(dto.occasionNote !== undefined
          ? { occasionNote: dto.occasionNote }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });

    if (dto.tableId && dto.tableId !== existing.tableId) {
      await this.prisma.restaurantTable.update({
        where: { id: dto.tableId },
        data: { status: 'RESERVED' },
      });
      const stillHeld = await this.prisma.reservation.count({
        where: {
          tableId: existing.tableId,
          status: 'ACTIVE',
          NOT: { id },
        },
      });
      if (stillHeld === 0) {
        await this.prisma.restaurantTable.update({
          where: { id: existing.tableId },
          data: { status: 'AVAILABLE' },
        });
      }
    }

    return this.map(updated);
  }

  async seat(ctx: TenantContext, id: string) {
    const reservation = await this.assertActive(ctx, id);

    const table = await this.prisma.restaurantTable.findFirst({
      where: { id: reservation.tableId },
    });
    if (!table) throw new NotFoundException('Table not found');
    if (table.status !== 'RESERVED' && table.status !== 'AVAILABLE') {
      throw new ConflictException(
        `Table status is ${table.status}, cannot seat reservation`,
      );
    }

    const [seated] = await this.prisma.$transaction([
      this.prisma.reservation.update({
        where: { id },
        data: { status: 'SEATED', seatedAt: new Date() },
      }),
      this.prisma.restaurantTable.update({
        where: { id: reservation.tableId },
        data: { status: 'AVAILABLE' },
      }),
    ]);

    this.events.emit(TABLE_UPDATED, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      tableId: reservation.tableId,
      reason: 'reservation-seated',
    } satisfies TableUpdatedEvent);

    return this.map(seated);
  }

  async cancel(ctx: TenantContext, id: string, dto: CancelReservationDto) {
    const reservation = await this.assertActive(ctx, id);

    const cancelled = await this.prisma.reservation.update({
      where: { id },
      data: { status: 'CANCELLED', cancelReason: dto.reason },
    });

    const remaining = await this.prisma.reservation.count({
      where: {
        tableId: reservation.tableId,
        status: 'ACTIVE',
      },
    });
    if (remaining === 0) {
      await this.prisma.restaurantTable.update({
        where: { id: reservation.tableId },
        data: { status: 'AVAILABLE' },
      });
      this.events.emit(TABLE_UPDATED, {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        tableId: reservation.tableId,
        reason: 'reservation-cancelled',
      } satisfies TableUpdatedEvent);
    }

    return this.map(cancelled);
  }

  private async assertActive(ctx: TenantContext, id: string) {
    const reservation = await this.prisma.reservation.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!reservation)
      throw new NotFoundException(`Reservation ${id} not found`);
    if (reservation.status !== 'ACTIVE')
      throw new UnprocessableEntityException(
        `Reservation is ${reservation.status}`,
      );
    return reservation;
  }

  private map(r: {
    id: string;
    tenantId: string;
    branchId: string;
    tableId: string;
    guestName: string | null;
    guestPhone: string | null;
    partySize: number | null;
    scheduledAt: Date;
    scheduledEnd: Date | null;
    occasion: string | null;
    occasionNote: string | null;
    notes: string | null;
    status: string;
    cancelReason: string | null;
    seatedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: r.id,
      tenantId: r.tenantId,
      branchId: r.branchId,
      tableId: r.tableId,
      guestName: r.guestName,
      guestPhone: r.guestPhone,
      partySize: r.partySize,
      scheduledAt: r.scheduledAt.getTime(),
      scheduledEnd: r.scheduledEnd?.getTime() ?? null,
      occasion: r.occasion,
      occasionNote: r.occasionNote,
      notes: r.notes,
      status: r.status,
      cancelReason: r.cancelReason,
      seatedAt: r.seatedAt?.getTime() ?? null,
      createdAt: r.createdAt.getTime(),
    };
  }
}
