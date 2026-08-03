import { performance } from 'perf_hooks';

const VERTICAL_ALIASES: Record<string, string> = {
  restaurant: 'restaurant',
  restaurante: 'restaurant',
  barber: 'barber',
  barberia: 'barber',
  barbershop: 'barber',
  retail: 'retail',
  tienda: 'retail',
  minorista: 'retail',
};

const RESERVED_MENU_SLUGS = new Set([
  'api',
  'admin',
  'menu',
  'settings',
  'login',
  'dashboard',
  'app',
]);

export function normalizeVertical(vertical: string): string {
  const value = vertical.trim().toLowerCase();
  return VERTICAL_ALIASES[value] ?? value;
}

export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function isMenuSlugReserved(slug: string): boolean {
  return RESERVED_MENU_SLUGS.has(slug);
}

export function defaultMenuTheme(tenantName: string) {
  return {
    templateId: 'cards',
    primaryColor: '#16a34a',
    accentColor: '#f97316',
    heroTitle: tenantName,
    heroDescription: 'Explora nuestra carta',
    featuredTitle: 'Destacados',
    featuredDescription: 'Los favoritos de la casa',
  };
}

export function elapsedMs(start: number): number {
  return performance.now() - start;
}

export function toServerTimingHeader(
  timings: Record<string, number>,
): string {
  return Object.entries(timings)
    .map(([key, value]) => `${key};dur=${value.toFixed(1)}`)
    .join(', ');
}
