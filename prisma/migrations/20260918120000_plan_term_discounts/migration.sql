-- Descuento por pago anticipado (3 / 6 / 12 meses), con fecha efectiva.
--
-- Append-only igual que `plan_prices` y `platform_rates`: nunca se hace UPDATE
-- ni DELETE. Un cobro pregunta el descuento vigente A SU FECHA, así que cambiar
-- la política más adelante no toca lo ya cobrado.
--
-- `verticalCode` / `planCode` en NULL = "para todos". La resolución va de lo
-- específico a lo general: (vertical, plan) > (vertical, NULL) > (NULL, NULL).

CREATE TABLE "plan_term_discounts" (
  "id"            TEXT NOT NULL,
  "verticalCode"  TEXT,
  "planCode"      TEXT,
  "termMonths"    INTEGER NOT NULL,
  "discountBps"   INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "note"          TEXT,
  "createdBy"     TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "plan_term_discounts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "plan_term_discounts_lookup_idx"
  ON "plan_term_discounts" ("verticalCode", "planCode", "termMonths", "effectiveFrom");

-- Política de arranque, global para las tres verticales. Son los valores
-- estándar del mercado SaaS, no un invento: el ancla es el año a ~17% ("dos
-- meses gratis"), y el resto escala con el riesgo que asume el cliente.
-- Editables desde el backoffice: cambiarlos inserta filas nuevas, no pisa estas.
INSERT INTO "plan_term_discounts"
  ("id", "verticalCode", "planCode", "termMonths", "discountBps", "effectiveFrom", "note")
VALUES
  ('seed_term_3',  NULL, NULL,  3,   500, CURRENT_TIMESTAMP, 'Política inicial: trimestre 5%'),
  ('seed_term_6',  NULL, NULL,  6,  1000, CURRENT_TIMESTAMP, 'Política inicial: semestre 10%'),
  ('seed_term_12', NULL, NULL, 12,  1700, CURRENT_TIMESTAMP, 'Política inicial: año 17% (dos meses gratis)');
