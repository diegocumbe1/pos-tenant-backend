import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { NotTrainerGuard } from '../../../auth/guards/not-trainer.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { BarberStaffService } from './barber-staff.service';

const ctx = { tenantId: 't', branchId: 'b', userId: 'u' } as TenantContext;

function build(overrides: {
  bookingMode?: string;
  staffUserId?: string | null;
  linkedRole?: string;
}) {
  const prisma = {
    barberSettings: {
      findFirst: jest.fn().mockResolvedValue({ bookingMode: overrides.bookingMode }),
    },
    barberStaff: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ userId: overrides.staffUserId ?? null }),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ role: { code: overrides.linkedRole } }),
    },
    $transaction: jest.fn(),
  };
  const helper = { assertScopedRecord: jest.fn().mockResolvedValue(undefined) };
  const tenantAdmin = { deactivateUser: jest.fn(), inviteUser: jest.fn() };
  const service = new BarberStaffService(
    prisma as never,
    helper as never,
    tenantAdmin as never,
  );
  return { service, prisma, tenantAdmin };
}

describe('acceso del entrenador', () => {
  it.each(['services', 'resources'])('no se da en agenda %s', async (bookingMode) => {
    const { service, prisma, tenantAdmin } = build({ bookingMode });
    await expect(
      service.grantAccess(ctx, 's', { email: 'c@x.co' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tenantAdmin.inviteUser).not.toHaveBeenCalled();
  });

  it('quitarlo desactiva al entrenador y lo suelta de la ficha', async () => {
    const { service, prisma, tenantAdmin } = build({
      staffUserId: 'carlos',
      linkedRole: 'TRAINER',
    });
    await service.revokeAccess(ctx, 's');
    expect(tenantAdmin.deactivateUser).toHaveBeenCalledWith('t', 'carlos');
    expect(prisma.barberStaff.update).toHaveBeenCalledWith({
      where: { id: 's' },
      data: { userId: null },
    });
  });

  it('no le quita la cuenta a un dueño enlazado a una ficha', async () => {
    const { service, tenantAdmin } = build({
      staffUserId: 'ana',
      linkedRole: 'OWNER',
    });
    await service.revokeAccess(ctx, 's');
    expect(tenantAdmin.deactivateUser).not.toHaveBeenCalled();
  });
});

describe('NotTrainerGuard', () => {
  const context = (roleCode: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ tenantContext: { roleCode } }),
      }),
    }) as unknown as ExecutionContext;

  it('frena al entrenador', () => {
    expect(() => new NotTrainerGuard().canActivate(context('TRAINER'))).toThrow(
      ForbiddenException,
    );
  });

  it('deja pasar a los demás roles', () => {
    expect(new NotTrainerGuard().canActivate(context('MANAGER'))).toBe(true);
  });
});
