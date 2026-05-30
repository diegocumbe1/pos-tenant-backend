import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export const RESERVED_BOOKING_SLUGS = new Set([
  'api',
  'admin',
  'app',
  'auth',
  'barber',
  'dashboard',
  'login',
  'public',
  'settings',
]);

export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export async function assertBookingSlugAvailable(
  prisma: PrismaService,
  slug: string,
  tenantId: string,
): Promise<void> {
  if (RESERVED_BOOKING_SLUGS.has(slug)) {
    throw new BadRequestException({
      code: 'BOOKING_SLUG_RESERVED',
      message: `Booking slug is reserved: ${slug}`,
    });
  }

  const existing = await prisma.barberSettings.findUnique({
    where: { bookingSlug: slug },
    select: { tenantId: true },
  });
  if (existing && existing.tenantId !== tenantId) {
    throw new ConflictException({
      code: 'BOOKING_SLUG_TAKEN',
      message: `Booking slug is already taken: ${slug}`,
    });
  }
}

export async function nextAvailableBookingSlug(
  prisma: PrismaService,
  baseSlug: string,
): Promise<string> {
  let candidate = baseSlug || 'barber';
  if (RESERVED_BOOKING_SLUGS.has(candidate)) candidate = `${candidate}-1`;

  for (let index = 0; index < 100; index += 1) {
    const slug = index === 0 ? candidate : `${candidate}-${index + 1}`;
    const existing = await prisma.barberSettings.findUnique({
      where: { bookingSlug: slug },
      select: { id: true },
    });
    if (!existing && !RESERVED_BOOKING_SLUGS.has(slug)) return slug;
  }

  throw new ConflictException({
    code: 'BOOKING_SLUG_TAKEN',
    message: 'Could not generate available booking slug',
  });
}
