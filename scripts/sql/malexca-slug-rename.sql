-- Renombra el sitio público de Malexca: malexca-2 → malexca.
-- Borra el sitio viejo que ocupe 'malexca' (cascada a secciones/assets) y
-- renombra el bookingSlug de otra sede si lo tuviera (no se borra: rompería esa sede).
-- Todo en una transacción; al final pide confirmar antes del COMMIT.
--
-- Uso: psql "$DIRECT_URL" -f scripts/sql/malexca-slug-rename.sql

\set ON_ERROR_STOP on

BEGIN;

DELETE FROM public_sites
WHERE (slug = 'malexca' OR "publishedSlug" = 'malexca')
  AND slug <> 'malexca-2';

UPDATE barber_settings
SET "bookingSlug" = 'malexca-old-' || substr("branchId", 1, 6)
WHERE "bookingSlug" = 'malexca'
  AND "branchId" <> (SELECT "branchId" FROM public_sites WHERE slug = 'malexca-2');

UPDATE public_sites
SET slug = 'malexca',
    "publishedSlug" = CASE WHEN status = 'published' THEN 'malexca' ELSE "publishedSlug" END,
    "updatedAt" = now()
WHERE slug = 'malexca-2';

UPDATE barber_settings
SET "bookingSlug" = 'malexca'
WHERE "branchId" = (SELECT "branchId" FROM public_sites WHERE slug = 'malexca');

-- Resultado dentro de la transacción (todavía sin confirmar)
SELECT id, slug, "publishedSlug", status FROM public_sites WHERE slug LIKE 'malexca%';
SELECT "branchId", "bookingSlug" FROM barber_settings WHERE "bookingSlug" LIKE 'malexca%';

\prompt '¿Confirmar el cambio? (escribe si): ' confirm
SELECT :'confirm' = 'si' AS confirmed \gset
\if :confirmed
  COMMIT;
  \echo '✓ Cambio aplicado'
\else
  ROLLBACK;
  \echo 'Cancelado, no se cambió nada'
\endif
