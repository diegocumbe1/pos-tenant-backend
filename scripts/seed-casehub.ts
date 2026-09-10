import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Siembra CaseHub — tienda de fundas de iPhone — sobre el modelo del vertical
 * retail (retail_categories / retail_products / retail_stock_movements):
 *   - BusinessVertical 'retail' + tenant + branch
 *   - Roles del sistema con permisos retail:*
 *   - Categoría por MODELO de iPhone + sus fundas, con stock inicial y kardex
 *   - PublicSite publicado en el slug 'casehub'
 *
 * Idempotente (upserts). Requiere `prisma migrate deploy` y `npm run db:seed`
 * (catálogo de permisos) ejecutados antes.
 *
 * Uso:
 *   npm run seed:casehub -- --whatsapp 573001234567
 *
 * El usuario dueño NO se crea aquí: los usuarios viven en Supabase Auth. Para
 * tener login real, invita al dueño sobre este tenant:
 *   POST /api/v1/tenant/users/invite   (o /auth/signup-invite para un tenant nuevo)
 */

const prisma = new PrismaClient();

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

const WHATSAPP = (arg('--whatsapp') ?? '573000000000').replace(/\D/g, '');
const SLUG = 'casehub';
const VERTICAL_ID = 'vertical-retail';
const TENANT_ID = 'tenant-casehub';
const BRANCH_ID = 'branch-casehub';

/**
 * La bodega principal de la tienda. Mismo id derivado que usan la migración y
 * `ensureDefaultLocation`, para que el seed no cree una segunda.
 *
 * El seed escribe stock directo en la tabla, sin pasar por el servicio, así que
 * tiene que sembrar los saldos a mano: sin esto la demo mostraría todo el
 * inventario como "sin ubicar", que es justo lo que la pantalla existe para
 * evitar.
 */
const MAIN_LOCATION_ID = `loc_${TENANT_ID}_${BRANCH_ID}`;

async function ensureMainLocation() {
  await prisma.retailStockLocation.upsert({
    where: { id: MAIN_LOCATION_ID },
    update: {},
    create: {
      id: MAIN_LOCATION_ID,
      tenantId: TENANT_ID,
      branchId: BRANCH_ID,
      name: 'Bodega principal',
      isDefault: true,
      sortOrder: 0,
    },
  });
}

async function seedBalance(productId: string, qty: number) {
  if (qty === 0) return;
  await prisma.retailStockBalance.upsert({
    where: { id: `bal_${productId}` },
    update: {},
    create: {
      id: `bal_${productId}`,
      tenantId: TENANT_ID,
      branchId: BRANCH_ID,
      locationId: MAIN_LOCATION_ID,
      productId,
      qty,
    },
  });
}

const img = (seed: string, w = 800, h = 600) =>
  `https://picsum.photos/seed/${seed}/${w}/${h}`;

// Fotos reales servidas por el frontend desde /public/cases. Al subir las fotos
// definitivas por la UI (POST /assets/catalog/retail-product/:id/images) estas
// rutas se reemplazan por URLs del storage.
const CASE_IMG = {
  negraNaranja: '/cases/negra-naranja-antigolpes.png',
  name17: '/cases/transparente-name17.png',
  negraMagsafe: '/cases/negra-magsafe.png',
  blancaNaranja: '/cases/blanca-naranja-magsafe.png',
  transparenteMagsafe: '/cases/transparente-magsafe.png',
  negraCompleta: '/cases/negra-completa-magsafe.png',
};

/**
 * Catálogo agrupado por MODELO de iPhone (la categoría ES el modelo).
 * Para agregar otro modelo: duplica el bloque con nuevo id/name y sus fundas.
 */
const CATEGORIES = [
  {
    id: 'retcat-casehub-17pro',
    name: 'iPhone 17 Pro',
    emoji: '📱',
    products: [
      {
        id: 'retprod-casehub-negra-naranja',
        name: 'Funda Negra · Naranja Anti Golpes',
        description:
          'Protección reforzada anti golpes. Negra con detalles naranja y ventana de cámara.',
        sku: 'CH-17P-NEG-NAR',
        priceCOP: 55000,
        costCOP: 22000,
        stock: 12,
        emoji: '🟠',
        imageUrls: [CASE_IMG.negraNaranja],
        attributes: { color: 'Negra/Naranja', magsafe: false, compatible: 'iPhone 17 Pro' },
      },
      {
        id: 'retprod-casehub-name17',
        name: 'Funda Transparente · Name 17',
        description:
          'Transparente con diseño personalizable: nombre, número y balón de fútbol.',
        sku: 'CH-17P-TRN-NAME',
        priceCOP: 50000,
        costCOP: 19000,
        stock: 8,
        emoji: '⚽',
        imageUrls: [CASE_IMG.name17],
        attributes: { color: 'Transparente', personalizable: true, compatible: 'iPhone 17 Pro' },
      },
      {
        id: 'retprod-casehub-negra-magsafe',
        name: 'Funda Negra · MagSafe',
        description:
          'Bumper negro con espalda transparente y anillo MagSafe integrado.',
        sku: 'CH-17P-NEG-MGS',
        priceCOP: 45000,
        costCOP: 18000,
        stock: 15,
        emoji: '🖤',
        imageUrls: [CASE_IMG.negraMagsafe],
        attributes: { color: 'Negra', magsafe: true, compatible: 'iPhone 17 Pro' },
      },
      {
        id: 'retprod-casehub-blanca-naranja',
        name: 'Funda Blanca · Naranja MagSafe',
        description:
          'Blanca con acentos naranja y anillo MagSafe. Diseño limpio y moderno.',
        sku: 'CH-17P-BLA-MGS',
        priceCOP: 48000,
        costCOP: 19500,
        stock: 6,
        emoji: '⚪',
        imageUrls: [CASE_IMG.blancaNaranja],
        attributes: { color: 'Blanca/Naranja', magsafe: true, compatible: 'iPhone 17 Pro' },
      },
      {
        id: 'retprod-casehub-transparente-magsafe',
        name: 'Funda Transparente · MagSafe',
        description:
          'Transparente anti-amarilleo con anillo MagSafe. Muestra el color original.',
        sku: 'CH-17P-TRN-MGS',
        priceCOP: 45000,
        costCOP: 17500,
        stock: 20,
        emoji: '🔵',
        imageUrls: [CASE_IMG.transparenteMagsafe],
        attributes: { color: 'Transparente', magsafe: true, compatible: 'iPhone 17 Pro' },
      },
      {
        id: 'retprod-casehub-negra-completa',
        name: 'Funda Negra Completa · MagSafe',
        description:
          'Cuero negro completo con MagSafe. Tacto premium y protección total.',
        sku: 'CH-17P-CUE-MGS',
        priceCOP: 65000,
        costCOP: 28000,
        stock: 4,
        emoji: '⬛',
        imageUrls: [CASE_IMG.negraCompleta],
        attributes: { color: 'Negra cuero', magsafe: true, compatible: 'iPhone 17 Pro' },
      },
    ],
  },
];

const THEME = {
  primary: '#f97316',
  accent: '#0ea5e9',
  ink: '#e5e7eb',
  background: '#0a0a0f',
  surface: '#13131c',
  radius: 'lg',
};

const BUSINESS = {
  name: 'CaseHub',
  shortName: 'CaseHub',
  address: 'Cra. 15 #45-20, Local 8',
  neighborhood: 'Centro',
  city: 'Bogotá',
  phone: WHATSAPP,
  whatsapp: WHATSAPP,
};

const SECTIONS = [
  {
    type: 'hero',
    isVisible: true,
    sortOrder: 10,
    width: 'full',
    density: 'immersive',
    title: 'CaseHub',
    eyebrow: 'Fundas para iPhone 17 Pro',
    subtitle: 'Protege tu iPhone con estilo. Elige tu funda y pídela por WhatsApp.',
    ctaLabel: 'Pedir por WhatsApp',
    ctaAction: 'open_whatsapp',
    settings: {} as Prisma.InputJsonValue,
  },
  {
    type: 'catalog',
    isVisible: true,
    sortOrder: 20,
    width: 'wide',
    density: 'comfortable',
    title: 'Catálogo',
    subtitle: 'Fundas para iPhone 17 Pro. Pronto más modelos.',
    ctaLabel: 'Pedir por WhatsApp',
    ctaAction: 'open_whatsapp',
    settings: { showPrices: true, groupByCategory: true } as Prisma.InputJsonValue,
  },
  {
    type: 'contact',
    isVisible: true,
    sortOrder: 30,
    width: 'contained',
    density: 'compact',
    title: 'Escríbenos',
    settings: {} as Prisma.InputJsonValue,
  },
];

const ASSETS = [
  {
    kind: 'hero',
    url: img('casehub-store', 1600, 900),
    alt: 'Fundas para iPhone 17 Pro',
    fit: 'cover',
    focalPoint: 'center',
  },
];

const SOCIALS = [
  {
    provider: 'whatsapp',
    label: 'WhatsApp',
    url: `https://wa.me/${WHATSAPP}`,
    isVisible: true,
    sortOrder: 10,
  },
];

const STATS = [
  { label: 'Diseños disponibles', value: '6', isVisible: true, sortOrder: 10 },
  { label: 'Garantía', value: '30 días', isVisible: true, sortOrder: 20 },
  { label: 'Envío', value: 'Mismo día', isVisible: true, sortOrder: 30 },
];

const HIGHLIGHTS = [
  { label: 'Protección premium', isVisible: true, sortOrder: 10 },
  { label: 'Compatible MagSafe', isVisible: true, sortOrder: 20 },
  { label: 'Diseño preciso iPhone 17 Pro', isVisible: true, sortOrder: 30 },
];

/** Snapshot que consume el renderer público (mismo shape que SitePayload del FE). */
function buildPayload(status: 'draft' | 'published') {
  return {
    slug: SLUG,
    status,
    business: BUSINESS,
    seo: {
      title: 'CaseHub · Fundas para iPhone 17 Pro',
      description:
        'Fundas premium para iPhone 17 Pro: anti golpes, transparentes, MagSafe y cuero. Elige tu estilo y pide por WhatsApp.',
      ogImageUrl: img('casehub-hero', 1200, 630),
    },
    theme: THEME,
    assets: ASSETS.map((asset, index) => ({ id: `a${index}`, ...asset })),
    sections: SECTIONS.map((section, index) => ({
      id: `s${index}`,
      assetIds: section.type === 'hero' ? ['a0'] : [],
      ...section,
    })),
    stats: STATS,
    highlights: HIGHLIGHTS,
    socials: SOCIALS.map((social, index) => ({ id: `so${index}`, ...social })),
    instagram: { profileUrl: '', posts: [] },
  } as unknown as Prisma.InputJsonValue;
}

/** Roles del sistema del tenant, con los permisos ya sembrados en la DB. */
async function seedRoles(tenantId: string) {
  const perms = await prisma.permission.findMany();
  if (perms.length === 0) {
    throw new Error('Catálogo de permisos vacío — corre `npm run db:seed` primero');
  }
  const permByCode = new Map(perms.map((p) => [p.code, p.id]));
  const retailPerms = perms
    .filter((p) => p.code.startsWith('retail:'))
    .map((p) => p.code);

  const matrix: Record<string, { name: string; perms: string[] }> = {
    OWNER: {
      name: 'Dueño',
      perms: [...retailPerms, 'admin:users:invite', 'admin:roles:manage'],
    },
    MANAGER: {
      name: 'Gerente',
      perms: [
        ...retailPerms.filter(
          (p) => p !== 'retail:catalog:delete' && p !== 'retail:sales:void',
        ),
        'admin:users:invite',
      ],
    },
    CASHIER: {
      name: 'Cajero',
      perms: [
        'retail:catalog:read',
        'retail:inventory:read',
        'retail:sales:read',
        'retail:sales:write',
        'retail:customers:read',
        'retail:customers:write',
      ],
    },
  };

  for (const [code, def] of Object.entries(matrix)) {
    const role = await prisma.role.upsert({
      where: { tenantId_code: { tenantId, code } },
      update: { name: def.name, isSystem: true },
      create: { tenantId, code, name: def.name, isSystem: true },
    });
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: def.perms
        .map((code) => permByCode.get(code))
        .filter((id): id is string => Boolean(id))
        .map((permissionId) => ({ roleId: role.id, permissionId })),
      skipDuplicates: true,
    });
  }
}

async function main() {
  console.log(`Seeding CaseHub (whatsapp: ${WHATSAPP})…`);

  // 1) Vertical
  await prisma.businessVertical.upsert({
    where: { code: 'retail' },
    update: { name: 'Retail / Tienda', isActive: true },
    create: { id: VERTICAL_ID, code: 'retail', name: 'Retail / Tienda', isActive: true },
  });

  // 2) Tenant + branch
  const vertical = await prisma.businessVertical.findUniqueOrThrow({
    where: { code: 'retail' },
    select: { id: true },
  });
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: { name: 'CaseHub', verticalId: vertical.id, plan: 'PRO' },
    create: { id: TENANT_ID, name: 'CaseHub', verticalId: vertical.id, plan: 'PRO' },
  });
  await prisma.branch.upsert({
    where: { id: BRANCH_ID },
    update: { name: 'CaseHub', address: BUSINESS.address },
    create: {
      id: BRANCH_ID,
      tenantId: TENANT_ID,
      name: 'CaseHub',
      address: BUSINESS.address,
    },
  });

  // 3) Roles del tenant
  await seedRoles(TENANT_ID);
  console.log('✅ Roles (OWNER/MANAGER/CASHIER) con permisos retail:*');

  // La bodega principal tiene que existir antes del catálogo: es donde nace
  // todo el stock que el seed carga.
  await ensureMainLocation();

  // 4) Catálogo retail + kardex de carga inicial
  for (let c = 0; c < CATEGORIES.length; c += 1) {
    const category = CATEGORIES[c];
    await prisma.retailCategory.upsert({
      where: {
        tenantId_branchId_name: {
          tenantId: TENANT_ID,
          branchId: BRANCH_ID,
          name: category.name,
        },
      },
      update: { emoji: category.emoji, sortOrder: c * 10, isVisible: true, deletedAt: null },
      create: {
        id: category.id,
        tenantId: TENANT_ID,
        branchId: BRANCH_ID,
        name: category.name,
        emoji: category.emoji,
        sortOrder: c * 10,
      },
    });

    for (let p = 0; p < category.products.length; p += 1) {
      const product = category.products[p];
      const data = {
        tenantId: TENANT_ID,
        branchId: BRANCH_ID,
        categoryId: category.id,
        name: product.name,
        description: product.description,
        sku: product.sku,
        brand: 'CaseHub',
        costCOP: product.costCOP,
        priceCOP: product.priceCOP,
        emoji: product.emoji,
        imageUrls: product.imageUrls,
        trackStock: true,
        minStock: 3,
        isActive: true,
        isPublished: true,
        sortOrder: p * 10,
        attributes: product.attributes as Prisma.InputJsonValue,
        deletedAt: null,
      };
      // El stock solo se fija al crear: re-correr el seed no debe pisar el stock
      // real de la tienda ni duplicar el movimiento de carga inicial.
      const existing = await prisma.retailProduct.findUnique({
        where: { id: product.id },
        select: { id: true },
      });
      if (existing) {
        await prisma.retailProduct.update({ where: { id: product.id }, data });
        continue;
      }
      await prisma.retailProduct.create({
        data: { id: product.id, ...data, stock: product.stock },
      });
      await seedBalance(product.id, product.stock);
      await prisma.retailStockMovement.create({
        data: {
          tenantId: TENANT_ID,
          branchId: BRANCH_ID,
          productId: product.id,
          type: 'INITIAL',
          quantity: product.stock,
          stockAfter: product.stock,
          locationId: MAIN_LOCATION_ID,
          unitCostCOP: product.costCOP,
          reason: 'Carga inicial (seed)',
        },
      });
    }
  }
  console.log(
    `✅ Catálogo: ${CATEGORIES.length} categoría(s), ${CATEGORIES.reduce((n, c) => n + c.products.length, 0)} producto(s)`,
  );

  // 5) Sitio público publicado
  const scalars = {
    slug: SLUG,
    publishedSlug: SLUG,
    status: 'published',
    vertical: 'retail',
    publishedAt: new Date(),
    seoTitle: 'CaseHub · Fundas para iPhone 17 Pro',
    seoDescription:
      'Fundas premium para iPhone 17 Pro: anti golpes, transparentes, MagSafe y cuero. Elige tu estilo y pide por WhatsApp.',
    ogImageUrl: img('casehub-hero', 1200, 630),
    themePrimary: THEME.primary,
    themeAccent: THEME.accent,
    themeInk: THEME.ink,
    themeBackground: THEME.background,
    themeSurface: THEME.surface,
    themeRadius: THEME.radius,
    shortName: BUSINESS.shortName,
    neighborhood: BUSINESS.neighborhood,
    city: BUSINESS.city,
    phone: BUSINESS.phone,
    whatsapp: BUSINESS.whatsapp,
    draftPayload: buildPayload('draft'),
    publishedPayload: buildPayload('published'),
  };

  const sectionRows = SECTIONS.map((section) => ({
    type: section.type,
    isVisible: section.isVisible,
    sortOrder: section.sortOrder,
    width: section.width,
    density: section.density,
    title: section.title,
    eyebrow: 'eyebrow' in section ? section.eyebrow : undefined,
    subtitle: 'subtitle' in section ? section.subtitle : undefined,
    ctaLabel: 'ctaLabel' in section ? section.ctaLabel : undefined,
    ctaAction: 'ctaAction' in section ? section.ctaAction : undefined,
    settings: section.settings,
  }));

  await prisma.publicSite.upsert({
    where: { branchId: BRANCH_ID },
    update: {
      ...scalars,
      sections: { deleteMany: {}, create: sectionRows },
      assets: { deleteMany: {}, create: ASSETS },
      socialLinks: { deleteMany: {}, create: SOCIALS },
      stats: { deleteMany: {}, create: STATS },
      highlights: { deleteMany: {}, create: HIGHLIGHTS },
      instagramPosts: { deleteMany: {} },
    },
    create: {
      tenantId: TENANT_ID,
      branchId: BRANCH_ID,
      ...scalars,
      sections: { create: sectionRows },
      assets: { create: ASSETS },
      socialLinks: { create: SOCIALS },
      stats: { create: STATS },
      highlights: { create: HIGHLIGHTS },
    },
  });

  console.log(
    `✅ CaseHub listo. API: /public/sites/${SLUG}  ·  brochure: /sites/${SLUG}  ·  app: /retail`,
  );
  console.log(
    `ℹ️  Para login real invita al dueño sobre el tenant ${TENANT_ID} (POST /tenant/users/invite).`,
  );
  if (WHATSAPP === '573000000000') {
    console.log(
      '⚠️  WhatsApp de placeholder. Re-corre con: npm run seed:casehub -- --whatsapp <número>',
    );
  }
}

main()
  .catch((error) => {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
