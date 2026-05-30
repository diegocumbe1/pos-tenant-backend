import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

/**
 * Seeds the active service catalog required to publish the Malexca barber site.
 *
 * Idempotent: safe to re-run. It only targets the known active Malexca tenant
 * and branch used by the current owner login.
 *
 * Usage:
 *   npm run seed:malexca-services
 */

const prisma = new PrismaClient();

const TENANT_ID = 'tenant-dd09986f';
const BRANCH_ID = 'branch-141fd545';

const SERVICES = [
  {
    name: 'Corte de cabello',
    description: 'Corte clasico o moderno con asesoria segun tu estilo.',
    durationMin: 30,
    priceCOP: 25000,
    color: '#6366f1',
  },
  {
    name: 'Arreglo de barba',
    description: 'Perfilado, marcacion y acabado con navaja.',
    durationMin: 20,
    priceCOP: 18000,
    color: '#22c55e',
  },
  {
    name: 'Corte + barba',
    description: 'Servicio completo de corte, barba y acabado profesional.',
    durationMin: 45,
    priceCOP: 38000,
    color: '#f59e0b',
  },
  {
    name: 'Cejas',
    description: 'Limpieza y perfilado de cejas.',
    durationMin: 10,
    priceCOP: 10000,
    color: '#06b6d4',
  },
  {
    name: 'Limpieza facial',
    description: 'Limpieza facial basica para renovar la piel.',
    durationMin: 35,
    priceCOP: 35000,
    color: '#ec4899',
  },
];

async function main() {
  const tenant = await prisma.tenant.findUnique({
    where: { id: TENANT_ID },
    select: {
      id: true,
      name: true,
      vertical: { select: { code: true } },
      branches: { where: { id: BRANCH_ID }, select: { id: true, name: true } },
    },
  });

  if (!tenant) {
    throw new Error(`Tenant ${TENANT_ID} not found`);
  }
  if (tenant.vertical?.code !== 'barber') {
    throw new Error(`Tenant ${TENANT_ID} is not barber vertical`);
  }
  if (tenant.branches.length !== 1) {
    throw new Error(`Branch ${BRANCH_ID} not found for tenant ${TENANT_ID}`);
  }

  for (let index = 0; index < SERVICES.length; index += 1) {
    const service = SERVICES[index];
    await prisma.barberService.upsert({
      where: {
        branchId_name: {
          branchId: BRANCH_ID,
          name: service.name,
        },
      },
      update: {
        tenantId: TENANT_ID,
        branchId: BRANCH_ID,
        description: service.description,
        durationMin: service.durationMin,
        priceCOP: service.priceCOP,
        color: service.color,
        isActive: true,
        sortOrder: (index + 1) * 10,
      },
      create: {
        tenantId: TENANT_ID,
        branchId: BRANCH_ID,
        name: service.name,
        description: service.description,
        durationMin: service.durationMin,
        priceCOP: service.priceCOP,
        color: service.color,
        imageUrls: [],
        isActive: true,
        sortOrder: (index + 1) * 10,
      },
    });
  }

  const activeServices = await prisma.barberService.findMany({
    where: { tenantId: TENANT_ID, branchId: BRANCH_ID, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      durationMin: true,
      priceCOP: true,
      isActive: true,
      sortOrder: true,
    },
  });

  console.log(
    JSON.stringify(
      {
        tenantId: TENANT_ID,
        branchId: BRANCH_ID,
        activeServices,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
