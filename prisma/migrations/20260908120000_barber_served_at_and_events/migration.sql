-- Fecha del servicio prestado, histórico auditable de la cita, y el backfill de
-- las dos columnas del cliente que nunca se escribieron.
--
-- POR QUÉ `servedAt`. `scheduledAt` responde "cuándo quedó agendado" y
-- `createdAt` responde "cuándo se digitó". Falta la única que importa para la
-- lista de retoques y para los reportes: cuándo se PRESTÓ el servicio. El caso
-- real es registrar hoy un procedimiento que fue hace ocho días, y hoy eso entra
-- con fecha de hoy y corrompe el histórico. Editable, con el cambio auditado.
-- Mismo patrón que `retail_sales.soldAt`.
--
-- POR QUÉ EL HISTÓRICO DE EVENTOS. `notes` es un campo de texto que se acumula,
-- sin autor ni hora. No responde "¿quién le cambió la fecha a esta cita?" ni
-- "¿por qué se dejó en 150.000 si vale 180.000?". Calcado de
-- `retail_sale_events`, que ya resolvió exactamente esto.
--
-- POR QUÉ EL BACKFILL. `barber_customers.totalVisits` y `lastVisitAt` existen
-- desde su migración original y NINGUNA línea del backend las escribió nunca:
-- valen 0 y NULL para todo el mundo, así que la columna "Última visita" de la
-- pantalla de clientes sale vacía en producción. Se recalculan desde las citas
-- completadas que ya existen.
--
-- NO MUEVE FINANZAS EN ESTA MIGRACIÓN. El ingreso se sigue contando por
-- `scheduledAt` hasta que el servicio lo cambie a `servedAt`; el backfill deja
-- `servedAt = scheduledAt`, así que el primer día los dos dan el mismo número.

-- ─── 1. La fecha del servicio prestado ──────────────────────────────────────

ALTER TABLE "barber_appointments" ADD COLUMN "servedAt" TIMESTAMP(3);

-- La segmentación de clientes ("quién no vuelve desde…") filtra y ordena por
-- esta fecha, no por la agendada.
CREATE INDEX "barber_appointments_tenantId_branchId_servedAt_idx"
  ON "barber_appointments" ("tenantId", "branchId", "servedAt");
CREATE INDEX "barber_appointments_customerId_servedAt_idx"
  ON "barber_appointments" ("customerId", "servedAt");

-- ─── 2. Histórico auditable de la cita ──────────────────────────────────────

-- Lista cerrada a propósito: si aparece un hecho nuevo tiene que nombrarse aquí,
-- y así el histórico no se llena de cadenas sueltas que nadie puede filtrar.
CREATE TYPE "BarberAppointmentEventKind" AS ENUM (
  'CREATED',
  'COMPLETED',
  'DATE_CHANGED',
  'PRICE_CHANGED',
  'DISCOUNT_APPLIED',
  'LOYALTY_GRANTED',
  'CANCELLED',
  'NO_SHOW',
  'NOTE'
);

CREATE TABLE "barber_appointment_events" (
  "id"            TEXT NOT NULL,
  "tenantId"      TEXT NOT NULL,
  "branchId"      TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "kind"          "BarberAppointmentEventKind" NOT NULL,
  -- Frase lista para mostrar, congelada en el momento en que pasó.
  "summary"       TEXT NOT NULL,
  "note"          TEXT,
  -- Números crudos del hecho: fechas anterior y nueva, montos, ids.
  "detail"        JSONB,
  "userId"        TEXT,
  -- Nombre congelado: si después borran al usuario o le cambian el nombre, el
  -- histórico sigue diciendo quién fue.
  "userName"      TEXT,
  "occurredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "barber_appointment_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "barber_appointment_events_appointmentId_occurredAt_idx"
  ON "barber_appointment_events" ("appointmentId", "occurredAt");
CREATE INDEX "barber_appointment_events_tenantId_branchId_occurredAt_idx"
  ON "barber_appointment_events" ("tenantId", "branchId", "occurredAt");

ALTER TABLE "barber_appointment_events"
  ADD CONSTRAINT "barber_appointment_events_appointmentId_fkey"
  FOREIGN KEY ("appointmentId") REFERENCES "barber_appointments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 3. Backfill ────────────────────────────────────────────────────────────

-- `status` es un String libre y en la base conviven 'completed', 'COMPLETED' y
-- 'Completed' según por dónde entró la cita. Se compara en minúsculas, igual que
-- hace `isCompletedStatus()` en el código.

-- Las citas ya completadas se prestaron el día en que estaban agendadas: es lo
-- único que se sabe de ellas, y es la verdad en el caso normal.
UPDATE "barber_appointments"
   SET "servedAt" = "scheduledAt"
 WHERE LOWER("status") = 'completed';

-- Visitas y última visita: solo cuentan los servicios REALIZADOS. Nada de
-- canceladas, rechazadas, no-show ni pendientes — un no-show no es un servicio
-- prestado, y contarlo dispararía los bonos de lealtad solo.
UPDATE "barber_customers" c
   SET "totalVisits" = COALESCE(v."visits", 0),
       "lastVisitAt" = v."lastVisit"
  FROM (
    SELECT "customerId",
           COUNT(*)          AS "visits",
           MAX("servedAt")   AS "lastVisit"
      FROM "barber_appointments"
     WHERE LOWER("status") = 'completed'
     GROUP BY "customerId"
  ) v
 WHERE c."id" = v."customerId";

-- Los clientes sin ninguna cita completada quedan explícitamente en cero, no en
-- lo que tuvieran antes (que era basura: nunca se escribió).
UPDATE "barber_customers"
   SET "totalVisits" = 0,
       "lastVisitAt" = NULL
 WHERE "id" NOT IN (
   SELECT DISTINCT "customerId"
     FROM "barber_appointments"
    WHERE LOWER("status") = 'completed'
 );
