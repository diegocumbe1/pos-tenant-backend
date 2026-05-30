import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Seeds the JIMCELL retail brochure (Fase 4):
 *   - BusinessVertical 'retail'
 *   - Tenant + Branch JIMCELL
 *   - Product categories + products (the live catalog)
 *   - A published PublicSite at slug 'jimcell' (vertical = retail)
 *
 * Idempotent (upserts) — safe to re-run. Requires the rename + catalog
 * migrations to be applied first (`prisma migrate deploy`).
 *
 * Usage:
 *   npm run seed:jimcell                       # placeholder WhatsApp number
 *   npm run seed:jimcell -- --whatsapp 573001234567
 */

const prisma = new PrismaClient();

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx === process.argv.length - 1) return undefined;
  return process.argv[idx + 1];
}

const WHATSAPP = (arg('--whatsapp') ?? '573000000000').replace(/\D/g, '');
const SLUG = 'jimcell';
const VERTICAL_ID = 'vertical-retail';
const TENANT_ID = 'tenant-jimcell';
const BRANCH_ID = 'branch-jimcell';

const img = (seed: string, w = 800, h = 600) =>
  `https://picsum.photos/seed/${seed}/${w}/${h}`;

// ─── Catalog (also seeded as real Product rows) ──────────────────────────────
const CATEGORIES = [
  {
    id: 'cat-jimcell-celulares',
    name: 'Celulares',
    emoji: '📱',
    products: [
      { id: 'prod-jimcell-iphone13', name: 'iPhone 13 128GB', description: 'Usado, excelente estado, batería 90%.', priceCOP: 1850000, emoji: '📱' },
      { id: 'prod-jimcell-a54', name: 'Samsung Galaxy A54', description: 'Nuevo, sellado, garantía 1 año.', priceCOP: 1250000, emoji: '📱' },
      { id: 'prod-jimcell-note13', name: 'Xiaomi Redmi Note 13', description: 'Nuevo, 256GB, cámara 108MP.', priceCOP: 899000, emoji: '📱' },
    ],
  },
  {
    id: 'cat-jimcell-accesorios',
    name: 'Accesorios',
    emoji: '🎧',
    products: [
      { id: 'prod-jimcell-vidrio', name: 'Vidrio templado', description: 'Instalación incluida.', priceCOP: 25000, emoji: '🛡️' },
      { id: 'prod-jimcell-audifonos', name: 'Audífonos Bluetooth', description: 'Cancelación de ruido.', priceCOP: 120000, emoji: '🎧' },
      { id: 'prod-jimcell-cargador', name: 'Cargador rápido 25W', description: 'Original, tipo C.', priceCOP: 55000, emoji: '🔌' },
    ],
  },
  {
    id: 'cat-jimcell-reparacion',
    name: 'Reparación',
    emoji: '🔧',
    products: [
      { id: 'prod-jimcell-pantalla', name: 'Cambio de pantalla', description: 'Según modelo. Diagnóstico gratis.', priceCOP: 180000, emoji: '🔧' },
      { id: 'prod-jimcell-bateria', name: 'Cambio de batería', description: 'Batería nueva con garantía.', priceCOP: 90000, emoji: '🔋' },
    ],
  },
];

// ─── Public site content (drives publishedPayload + editor rows) ─────────────
const THEME = {
  primary: '#22d3ee',
  accent: '#a855f7',
  ink: '#e5e7eb',
  background: '#0a0a0f',
  surface: '#13131c',
  radius: 'lg',
};

const BUSINESS = {
  name: 'JIMCELL',
  shortName: 'JIMCELL',
  address: 'CRR 11 # 8-37',
  neighborhood: 'Centro',
  city: 'Garzón, Huila',
  phone: WHATSAPP,
  whatsapp: WHATSAPP,
};

const ASSETS = [
  { id: 'asset-jimcell-hero', kind: 'hero', url: img('jimcell-store', 1600, 900), alt: 'Tienda JIMCELL', fit: 'cover', focalPoint: 'center' },
  { id: 'asset-jimcell-g1', kind: 'gallery', url: img('jimcell-g1'), alt: 'Vitrina de celulares', fit: 'cover', focalPoint: 'center' },
  { id: 'asset-jimcell-g2', kind: 'gallery', url: img('jimcell-g2'), alt: 'Accesorios', fit: 'cover', focalPoint: 'center' },
  { id: 'asset-jimcell-g3', kind: 'gallery', url: img('jimcell-g3'), alt: 'Reparación de equipos', fit: 'cover', focalPoint: 'center' },
  { id: 'asset-jimcell-g4', kind: 'gallery', url: img('jimcell-g4'), alt: 'Mostrador', fit: 'cover', focalPoint: 'center' },
];

const SECTIONS = [
  {
    id: 'sec-jimcell-hero', type: 'hero', isVisible: true, sortOrder: 10, width: 'full', density: 'immersive',
    title: 'JIMCELL', eyebrow: 'Tu tienda de tecnología',
    subtitle: 'Celulares, accesorios y servicio técnico de confianza.',
    ctaLabel: 'Pedir por WhatsApp', ctaAction: 'open_whatsapp',
    assetIds: ['asset-jimcell-hero'], settings: {},
  },
  {
    id: 'sec-jimcell-services', type: 'services', isVisible: true, sortOrder: 20, width: 'contained', density: 'comfortable',
    title: 'Qué hacemos por ti', subtitle: 'Tres servicios, una sola tienda de confianza.',
    assetIds: [],
    settings: {
      items: [
        { icon: 'smartphone', title: 'Venta de celulares', body: 'Equipos nuevos y usados de las mejores marcas, con garantía.' },
        { icon: 'wrench', title: 'Reparación técnica', body: 'Cambio de pantalla, batería, software y micro-soldadura.' },
        { icon: 'headphones', title: 'Accesorios', body: 'Forros, vidrios templados, cargadores y audífonos originales.' },
      ],
    },
  },
  {
    id: 'sec-jimcell-catalog', type: 'catalog', isVisible: true, sortOrder: 30, width: 'wide', density: 'comfortable',
    title: 'Catálogo', subtitle: 'Arma tu pedido y envíalo por WhatsApp en un toque.',
    ctaLabel: 'Pedir por WhatsApp', ctaAction: 'open_whatsapp',
    assetIds: [], settings: { showPrices: true, groupByCategory: true },
  },
  {
    id: 'sec-jimcell-gallery', type: 'gallery', isVisible: true, sortOrder: 40, width: 'wide', density: 'comfortable',
    title: 'La tienda', assetIds: ['asset-jimcell-g1', 'asset-jimcell-g2', 'asset-jimcell-g3', 'asset-jimcell-g4'], settings: {},
  },
  {
    id: 'sec-jimcell-instagram', type: 'instagram', isVisible: true, sortOrder: 50, width: 'contained', density: 'comfortable',
    title: 'Síguenos en Instagram', assetIds: [], settings: {},
  },
  {
    id: 'sec-jimcell-contact', type: 'contact', isVisible: true, sortOrder: 60, width: 'contained', density: 'compact',
    title: 'Visítanos o escríbenos', assetIds: [], settings: {},
  },
];

const SOCIALS = [
  { id: 'soc-jimcell-ig', provider: 'instagram', label: 'Instagram', url: 'https://www.instagram.com/jim__cell', isVisible: true, sortOrder: 10 },
  { id: 'soc-jimcell-wa', provider: 'whatsapp', label: 'WhatsApp', url: `https://wa.me/${WHATSAPP}`, isVisible: true, sortOrder: 20 },
];

const STATS = [
  { id: 'stat-jimcell-1', label: 'Años en el mercado', value: '8+', isVisible: true, sortOrder: 10 },
  { id: 'stat-jimcell-2', label: 'Equipos reparados', value: '5.000+', isVisible: true, sortOrder: 20 },
  { id: 'stat-jimcell-3', label: 'Garantía', value: '90 días', isVisible: true, sortOrder: 30 },
];

const HIGHLIGHTS = [
  { id: 'hl-jimcell-1', label: 'Garantía real', isVisible: true, sortOrder: 10 },
  { id: 'hl-jimcell-2', label: 'Diagnóstico gratis', isVisible: true, sortOrder: 20 },
  { id: 'hl-jimcell-3', label: 'Entrega el mismo día', isVisible: true, sortOrder: 30 },
];

/** Build the SitePayload JSON consumed by GET /public/sites/:slug. */
function buildPayload(version: 'draft' | 'published') {
  return {
    slug: SLUG,
    status: 'published',
    version,
    publishedAt: new Date().toISOString(),
    business: BUSINESS,
    seo: {
      title: 'JIMCELL · Celulares, accesorios y servicio técnico',
      description: 'Venta de celulares, accesorios originales y reparación técnica. Pide por WhatsApp.',
      ogImageUrl: img('jimcell-hero', 1200, 630),
    },
    theme: THEME,
    assets: ASSETS,
    sections: SECTIONS,
    stats: STATS,
    highlights: HIGHLIGHTS,
    socials: SOCIALS,
    instagram: { profileUrl: 'https://www.instagram.com/jim__cell', posts: [] },
  } as Prisma.InputJsonValue;
}

async function main() {
  console.log(`Seeding JIMCELL (whatsapp: ${WHATSAPP})…`);

  // 1) Vertical
  await prisma.businessVertical.upsert({
    where: { code: 'retail' },
    update: { name: 'Retail / Tienda', isActive: true },
    create: { id: VERTICAL_ID, code: 'retail', name: 'Retail / Tienda', isActive: true },
  });

  // 2) Tenant
  await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: { name: 'JIMCELL', verticalId: VERTICAL_ID, plan: 'PRO' },
    create: { id: TENANT_ID, name: 'JIMCELL', verticalId: VERTICAL_ID, plan: 'PRO' },
  });

  // 3) Branch
  await prisma.branch.upsert({
    where: { id: BRANCH_ID },
    update: { name: 'JIMCELL', address: BUSINESS.address },
    create: { id: BRANCH_ID, tenantId: TENANT_ID, name: 'JIMCELL', address: BUSINESS.address },
  });

  // 4) Categories + products
  for (let c = 0; c < CATEGORIES.length; c += 1) {
    const category = CATEGORIES[c];
    await prisma.productCategory.upsert({
      where: { tenantId_branchId_name: { tenantId: TENANT_ID, branchId: BRANCH_ID, name: category.name } },
      update: { emoji: category.emoji, sortOrder: c * 10 },
      create: { id: category.id, tenantId: TENANT_ID, branchId: BRANCH_ID, name: category.name, emoji: category.emoji, sortOrder: c * 10 },
    });
    for (let p = 0; p < category.products.length; p += 1) {
      const product = category.products[p];
      const data = {
        tenantId: TENANT_ID,
        branchId: BRANCH_ID,
        categoryId: category.id,
        name: product.name,
        description: product.description,
        priceCOP: product.priceCOP,
        emoji: product.emoji,
        imageUrls: [] as string[],
        isAvailable: true,
        sortOrder: p * 10,
        deletedAt: null,
      };
      await prisma.product.upsert({
        where: { id: product.id },
        update: data,
        create: { id: product.id, ...data },
      });
    }
  }

  // 5) Published public site (+ editor child rows)
  const draftPayload = buildPayload('draft');
  const publishedPayload = buildPayload('published');
  const scalars = {
    slug: SLUG,
    publishedSlug: SLUG,
    status: 'published',
    vertical: 'retail',
    publishedAt: new Date(),
    seoTitle: 'JIMCELL · Celulares, accesorios y servicio técnico',
    seoDescription: 'Venta de celulares, accesorios y reparación técnica. Pide por WhatsApp.',
    ogImageUrl: img('jimcell-hero', 1200, 630),
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
    draftPayload,
    publishedPayload,
  };

  const sectionRows = SECTIONS.map((s) => ({
    type: s.type,
    isVisible: s.isVisible,
    sortOrder: s.sortOrder,
    width: s.width,
    density: s.density,
    title: s.title,
    eyebrow: 'eyebrow' in s ? (s as { eyebrow?: string }).eyebrow : undefined,
    subtitle: 'subtitle' in s ? (s as { subtitle?: string }).subtitle : undefined,
    ctaLabel: 'ctaLabel' in s ? (s as { ctaLabel?: string }).ctaLabel : undefined,
    ctaAction: 'ctaAction' in s ? (s as { ctaAction?: string }).ctaAction : undefined,
    assetIds: s.assetIds,
    settings: s.settings as Prisma.InputJsonValue,
  }));
  const assetRows = ASSETS.map((a) => ({ kind: a.kind, url: a.url, alt: a.alt, fit: a.fit, focalPoint: a.focalPoint }));
  const socialRows = SOCIALS.map((s) => ({ provider: s.provider, label: s.label, url: s.url, isVisible: s.isVisible, sortOrder: s.sortOrder }));
  const statRows = STATS.map((s) => ({ label: s.label, value: s.value, isVisible: s.isVisible, sortOrder: s.sortOrder }));
  const highlightRows = HIGHLIGHTS.map((h) => ({ label: h.label, isVisible: h.isVisible, sortOrder: h.sortOrder }));

  await prisma.publicSite.upsert({
    where: { branchId: BRANCH_ID },
    update: {
      ...scalars,
      sections: { deleteMany: {}, create: sectionRows },
      assets: { deleteMany: {}, create: assetRows },
      socialLinks: { deleteMany: {}, create: socialRows },
      stats: { deleteMany: {}, create: statRows },
      highlights: { deleteMany: {}, create: highlightRows },
      instagramPosts: { deleteMany: {} },
    },
    create: {
      tenantId: TENANT_ID,
      branchId: BRANCH_ID,
      ...scalars,
      sections: { create: sectionRows },
      assets: { create: assetRows },
      socialLinks: { create: socialRows },
      stats: { create: statRows },
      highlights: { create: highlightRows },
    },
  });

  console.log(`✅ JIMCELL seeded. Public site: /public/sites/${SLUG}  ·  brochure: /sites/${SLUG}`);
  if (WHATSAPP === '573000000000') {
    console.log('⚠️  Using placeholder WhatsApp. Re-run with: npm run seed:jimcell -- --whatsapp <number>');
  }
}

main()
  .catch((error) => {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
