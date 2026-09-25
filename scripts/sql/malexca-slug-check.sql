-- Diagnóstico (solo lectura): quién ocupa 'malexca' y cuál es el sitio de Malexca.
-- Uso: psql "$DIRECT_URL" -f scripts/sql/malexca-slug-check.sql

SELECT ps.id, t.name AS tenant, ps."branchId", ps.slug, ps."publishedSlug", ps.status
FROM public_sites ps
JOIN tenants t ON t.id = ps."tenantId"
WHERE ps.slug IN ('malexca', 'malexca-2')
   OR ps."publishedSlug" IN ('malexca', 'malexca-2');

SELECT bs."branchId", t.name AS tenant, bs."bookingSlug"
FROM barber_settings bs
JOIN branches b ON b.id = bs."branchId"
JOIN tenants t ON t.id = b."tenantId"
WHERE bs."bookingSlug" IN ('malexca', 'malexca-2');
