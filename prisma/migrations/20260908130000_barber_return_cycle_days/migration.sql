-- Cada cuántos días toca volver a un servicio.
--
-- POR QUÉ. `resultDuration` ya existía, pero es texto libre ("8 a 12 meses") y
-- un string así no se compara con una fecha. Para armar la lista de "a quién le
-- toca retoque" hace falta un número. `resultDuration` se queda como está: es lo
-- que se muestra en el sitio público, escrito como lo dice cada negocio.
--
-- DOS VENTANAS, NO UNA. El retoque es el ajuste del mismo trabajo (~30 días en
-- micropigmentación); el mantenimiento es rehacerlo (~1 año). Son dos
-- conversaciones distintas con la clienta y las dos cobran.
--
-- NULLABLE A PROPÓSITO. Un servicio sin estos números simplemente no aparece en
-- la lista de vencidos. Nada se rompe si el negocio no los llena.

ALTER TABLE "barber_services" ADD COLUMN "retouchAfterDays" INTEGER;
ALTER TABLE "barber_services" ADD COLUMN "maintenanceAfterDays" INTEGER;
