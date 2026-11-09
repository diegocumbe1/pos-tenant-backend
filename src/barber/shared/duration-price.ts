/**
 * Precio de una reserva por su duración (canchas, salones: "se agenda por hora").
 *
 * Réplica exacta de `priceForMinutes` en el frontend
 * (verticals/barber/lib/booking-mode.ts):
 *   - La duración base del servicio vale `priceCOP`.
 *   - Si hay un bloque configurado para esos minutos con precio propio, ese.
 *   - Si no, proporcional a la tarifa por hora: round(minutos/60 × tarifa/h).
 *
 * Antes no existía en el servidor: una reserva de 2 h en una cancha de
 * $30.000/h se cobraba, se mostraba y se contaba en Finanzas por $30.000.
 */
export type DurationPricedService = {
  priceCOP: number;
  durationMin: number;
  durationOptions?: unknown;
};

type DurationOption = { minutes?: unknown; price?: unknown };

export function hourlyRateCOP(service: DurationPricedService): number {
  const hours = service.durationMin > 0 ? service.durationMin / 60 : 1;
  return Math.round(service.priceCOP / hours);
}

export function priceForMinutes(
  service: DurationPricedService,
  minutes: number,
): number {
  if (minutes === service.durationMin) return service.priceCOP;
  const options = Array.isArray(service.durationOptions)
    ? (service.durationOptions as DurationOption[])
    : [];
  const block = options.find((o) => Number(o?.minutes) === minutes);
  if (block && typeof block.price === 'number' && block.price >= 0) {
    return block.price;
  }
  return Math.round((minutes / 60) * hourlyRateCOP(service));
}

export function minutesBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

/**
 * Precio a guardar en la reserva al crearla o cambiarle la duración: solo si
 * NO es la duración base. En la duración base se deja null y manda el precio
 * del servicio hasta completarla, como siempre (así un cambio de tarifa antes
 * de la cita se respeta).
 */
export function storedPriceForDuration(
  service: DurationPricedService,
  minutes: number,
): number | null {
  return minutes === service.durationMin
    ? null
    : priceForMinutes(service, minutes);
}

/** Precio efectivo de una cita: el guardado, o el de su duración real. */
export function appointmentPriceCOP(apt: {
  priceCOP: number | null;
  scheduledAt: Date;
  scheduledEnd: Date;
  service: DurationPricedService;
}): number {
  return (
    apt.priceCOP ??
    priceForMinutes(
      apt.service,
      minutesBetween(apt.scheduledAt, apt.scheduledEnd),
    )
  );
}
