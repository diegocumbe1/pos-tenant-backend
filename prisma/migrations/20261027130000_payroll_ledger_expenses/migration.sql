-- Los pagos y adelantos de nómina ya registrados pasan a ser gasto (PAYROLL),
-- igual que los nuevos (StaffCompensationService.syncPayrollExpense).
-- Solo datos, sin cambios de esquema. Idempotente: el id es `payexp_<movimiento>`
-- y ON CONFLICT no vuelve a insertar. Sin sede en el movimiento se usa la
-- primera sede del negocio (Expense exige branchId).
INSERT INTO "expenses" ("id", "tenantId", "branchId", "category", "concept", "amountCOP", "incurredAt", "sourceType", "sourceId", "note")
SELECT
  'payexp_' || l."id",
  l."tenantId",
  COALESCE(l."branchId", (SELECT b."id" FROM "branches" b WHERE b."tenantId" = l."tenantId" ORDER BY b."createdAt" LIMIT 1)),
  'PAYROLL',
  'Nómina ' || l."staffName" || ' · ' || CASE WHEN l."type" = 'ADVANCE' THEN 'adelanto' ELSE 'pago' END || ' ' || l."period",
  l."amount",
  l."date",
  'STAFF_LEDGER',
  l."id",
  CASE WHEN l."method" = 'TRANSFER' THEN 'Transferencia' || COALESCE(' ' || l."accountLabel", '') ELSE 'Efectivo' END
    || COALESCE(' · ' || l."note", '')
FROM "staff_ledger_entries" l
WHERE l."type" IN ('PAYMENT', 'ADVANCE')
  AND COALESCE(l."branchId", (SELECT b."id" FROM "branches" b WHERE b."tenantId" = l."tenantId" ORDER BY b."createdAt" LIMIT 1)) IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
