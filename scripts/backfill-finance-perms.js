// Backfill: concede permisos de finanzas a roles de gestión existentes.
// OWNER/MANAGER -> restaurant:finance:read + write ; ADMIN -> read.
// Idempotente (skipDuplicates). Necesario para tenants creados antes de que
// el permiso de finanzas existiera (p.ej. tenants barber). Ejecutar una vez:
//   node scripts/backfill-finance-perms.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const GRANTS = {
  OWNER: ['restaurant:finance:read', 'restaurant:finance:write'],
  MANAGER: ['restaurant:finance:read', 'restaurant:finance:write'],
  ADMIN: ['restaurant:finance:read'],
};

async function main() {
  const perms = await prisma.permission.findMany({
    where: { code: { in: ['restaurant:finance:read', 'restaurant:finance:write'] } },
  });
  const permByCode = new Map(perms.map((p) => [p.code, p.id]));
  if (permByCode.size < 2) {
    throw new Error('Finance permissions missing in catalog — run db:seed first');
  }

  const roles = await prisma.role.findMany({
    where: { code: { in: Object.keys(GRANTS) } },
    select: { id: true, code: true, tenantId: true },
  });

  let created = 0;
  for (const role of roles) {
    const data = GRANTS[role.code]
      .map((code) => permByCode.get(code))
      .filter(Boolean)
      .map((permissionId) => ({ roleId: role.id, permissionId }));
    const res = await prisma.rolePermission.createMany({ data, skipDuplicates: true });
    created += res.count;
  }

  console.log(`Roles procesados: ${roles.length} · role_permissions nuevas: ${created}`);

  // Verificación puntual para el tenant barber de la demo.
  const sample = await prisma.rolePermission.findMany({
    where: {
      role: { tenantId: 'tenant-e2593413', code: 'OWNER' },
      permission: { code: { startsWith: 'restaurant:finance' } },
    },
    include: { permission: { select: { code: true } } },
  });
  console.log('OWNER (tenant-e2593413) finance perms:', sample.map((s) => s.permission.code));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
