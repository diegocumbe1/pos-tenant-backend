-- Cuenta corriente con el proveedor: ficha real, recepción parcial y libro.
--
-- Continúa `20260902140000_retail_purchase_received_qty`, que separó "cuánto
-- pedí" de "cuánto llegó". Esa separación deja ver la diferencia; lo que falta
-- es saber en qué queda, y para eso hacen falta tres cosas.
--
-- 1. EL PROVEEDOR COMO FICHA. Era un `String?` escrito a mano en cada línea, y
--    el directorio del frontend vivía en `localStorage` (se perdía al cambiar de
--    equipo). Para llevarle cuenta a alguien hay que poder identificarlo:
--    "crea con arte" y "Crea con Arte" partían el saldo en dos.
--
-- 2. RECEPCIÓN PARCIAL. Recibir era todo-o-nada por línea. El caso real es el
--    contrario: «ya está pago y quedó faltando, así que no lo marco como
--    recibido». Cada tanda pasa a ser una fila de `retail_purchase_receipts`,
--    espejo de `retail_sale_deliveries`, que ya resuelve esto del otro lado.
--
--    Con eso aparece la distinción que no se podía hacer:
--      · PARTIALLY_RECEIVED = llegó una parte y puede seguir llegando. En
--        tránsito, NO es un faltante.
--      · RECEIVED con menos de lo pedido = se cerró la línea. AHÍ sí hay
--        faltante, y es un reclamo al proveedor.
--    Un faltante solo existe cuando alguien cierra la línea. Confundir las dos
--    cosas convertía cualquier pedido en curso en un reclamo.
--
-- 3. EL LIBRO. Un saldo derivado (girado − total del pedido) responde "cuánto
--    debo hoy" y nada más: no deja ver cómo se llegó al número, no tiene dónde
--    recibir una nota crédito, y las devoluciones que vienen después lo
--    obligarían a rehacerse. Cada hecho pasa a ser una fila con fecha y signo.
--    Positivo = le debo al proveedor. Negativo = el proveedor me debe.

-- ─── Enum del libro ──────────────────────────────────────────────────────────
CREATE TYPE "RetailSupplierLedgerKind" AS ENUM ('PURCHASE', 'PAYMENT', 'SHORTAGE', 'OVERAGE', 'CREDIT_NOTE', 'ADJUSTMENT');

-- ─── Proveedores ─────────────────────────────────────────────────────────────
CREATE TABLE "retail_suppliers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "city" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "retail_suppliers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "retail_suppliers_tenantId_branchId_name_key" ON "retail_suppliers"("tenantId", "branchId", "name");
CREATE INDEX "retail_suppliers_tenantId_branchId_deletedAt_idx" ON "retail_suppliers"("tenantId", "branchId", "deletedAt");

-- ─── Recepciones ─────────────────────────────────────────────────────────────
CREATE TABLE "retail_purchase_receipts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "purchaseItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCostCOP" INTEGER,
    "reference" TEXT,
    "note" TEXT,
    "stockMovementId" TEXT,
    "userId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retail_purchase_receipts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "retail_purchase_receipts_purchaseItemId_idx" ON "retail_purchase_receipts"("purchaseItemId");
CREATE INDEX "retail_purchase_receipts_tenantId_branchId_receivedAt_idx" ON "retail_purchase_receipts"("tenantId", "branchId", "receivedAt");

ALTER TABLE "retail_purchase_receipts" ADD CONSTRAINT "retail_purchase_receipts_purchaseItemId_fkey" FOREIGN KEY ("purchaseItemId") REFERENCES "retail_purchase_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Libro de movimientos ────────────────────────────────────────────────────
CREATE TABLE "retail_supplier_ledger_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "kind" "RetailSupplierLedgerKind" NOT NULL,
    "amountCOP" INTEGER NOT NULL,
    "purchaseItemId" TEXT,
    "expenseId" TEXT,
    "note" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,

    CONSTRAINT "retail_supplier_ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "retail_supplier_ledger_entries_supplierId_occurredAt_idx" ON "retail_supplier_ledger_entries"("supplierId", "occurredAt");
CREATE INDEX "retail_supplier_ledger_entries_tenantId_branchId_occurredAt_idx" ON "retail_supplier_ledger_entries"("tenantId", "branchId", "occurredAt");
CREATE INDEX "retail_supplier_ledger_entries_purchaseItemId_idx" ON "retail_supplier_ledger_entries"("purchaseItemId");

ALTER TABLE "retail_supplier_ledger_entries" ADD CONSTRAINT "retail_supplier_ledger_entries_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "retail_suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL: si se borra el pedido, el movimiento de plata sigue siendo cierto.
ALTER TABLE "retail_supplier_ledger_entries" ADD CONSTRAINT "retail_supplier_ledger_entries_purchaseItemId_fkey" FOREIGN KEY ("purchaseItemId") REFERENCES "retail_purchase_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Enlace del pedido a la ficha ────────────────────────────────────────────
ALTER TABLE "retail_purchase_items" ADD COLUMN     "supplierId" TEXT;
CREATE INDEX "retail_purchase_items_supplierId_idx" ON "retail_purchase_items"("supplierId");
ALTER TABLE "retail_purchase_items" ADD CONSTRAINT "retail_purchase_items_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "retail_suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Backfill 1: una ficha por cada nombre que ya exista ─────────────────────
--
-- Se agrupa por el nombre normalizado (sin espacios de sobra, sin distinguir
-- mayúsculas) porque ahí está el problema que la ficha viene a resolver. El
-- nombre que se guarda es el primero que se escribió, no el normalizado: es el
-- que el dueño reconoce, y corregirlo a mano después es un renombre trivial.
INSERT INTO "retail_suppliers" ("id", "tenantId", "branchId", "name", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  "tenantId",
  "branchId",
  MIN(TRIM("supplier")) AS name,
  NOW(),
  NOW()
FROM "retail_purchase_items"
WHERE "supplier" IS NOT NULL
  AND TRIM("supplier") <> ''
GROUP BY "tenantId", "branchId", LOWER(TRIM("supplier"));

-- Los pedidos apuntan a su ficha.
UPDATE "retail_purchase_items" AS i
SET "supplierId" = s."id"
FROM "retail_suppliers" AS s
WHERE i."tenantId" = s."tenantId"
  AND i."branchId" = s."branchId"
  AND i."supplier" IS NOT NULL
  AND LOWER(TRIM(i."supplier")) = LOWER(TRIM(s."name"));

-- ─── Backfill 2: lo ya recibido, como una recepción única ────────────────────
--
-- Cada línea RECEIVED tuvo exactamente una recepción: la del día que se marcó.
-- Se reconstruye con los datos que sí sobrevivieron, para que el histórico no
-- aparezca como "recibido de la nada" cuando la pantalla pase a listar tandas.
INSERT INTO "retail_purchase_receipts" ("id", "tenantId", "branchId", "purchaseItemId", "quantity", "unitCostCOP", "stockMovementId", "userId", "receivedAt")
SELECT
  gen_random_uuid()::text,
  "tenantId",
  "branchId",
  "id",
  COALESCE("receivedQuantity", "quantity"),
  COALESCE("receivedUnitCostCOP", "estimatedCostCOP"),
  "stockMovementId",
  "receivedById",
  COALESCE("receivedAt", "updatedAt")
FROM "retail_purchase_items"
WHERE "status" = 'RECEIVED';

-- ─── El libro NO se backfillea ───────────────────────────────────────────────
--
-- Arranca vacío a propósito. Reconstruir el saldo histórico de cada proveedor
-- exigiría saber qué se pidió y qué se pagó en cada pedido viejo, y esos son
-- justamente los datos que sabemos incompletos: la cantidad pedida se destruyó
-- al recibir en todo el histórico anterior a la migración pasada. Un saldo
-- inicial calculado sobre eso sería un número inventado con apariencia de
-- exacto, que es peor que no tener número.
--
-- El libro empieza a contar desde acá. Si hace falta arrastrar un saldo real de
-- antes, se registra como un movimiento ADJUSTMENT con su motivo escrito, que
-- deja claro que es un dato metido a mano y no una suma del sistema.
