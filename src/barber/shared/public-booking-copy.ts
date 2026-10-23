import { Prisma } from '@prisma/client';

/**
 * Vocabulary consumed by the public-site renderer.  It deliberately describes
 * an "item" instead of a service so the same booking flow can sell a haircut,
 * a court, a room or any other reservable resource.
 */
export type PublicBookingCopy = {
  itemSingular: string;
  itemPlural: string;
  bookingNoun: string;
  primaryCta: string;
  selectionPrompt: string;
  schedulePrompt: string;
  /** Quien atiende: "especialista" / "entrenador" / "responsable". */
  staffSingular: string;
  staffPlural: string;
};

export const DEFAULT_PUBLIC_BOOKING_COPY: Record<
  'services' | 'resources' | 'fitness',
  PublicBookingCopy
> = {
  services: {
    itemSingular: 'servicio',
    itemPlural: 'servicios',
    bookingNoun: 'cita',
    primaryCta: 'Reserva tu cita',
    selectionPrompt: 'Elige tu servicio',
    schedulePrompt: 'Aparta tu horario',
    staffSingular: 'especialista',
    staffPlural: 'especialistas',
  },
  // Gimnasio: lo que se agenda por la web es una sesión con entrenador.
  fitness: {
    itemSingular: 'sesión',
    itemPlural: 'sesiones',
    bookingNoun: 'sesión',
    primaryCta: 'Agenda tu sesión',
    selectionPrompt: 'Elige tu sesión',
    schedulePrompt: 'Aparta tu horario',
    staffSingular: 'entrenador',
    staffPlural: 'entrenadores',
  },
  resources: {
    itemSingular: 'espacio',
    itemPlural: 'espacios',
    bookingNoun: 'reserva',
    primaryCta: 'Reserva tu espacio',
    selectionPrompt: 'Elige tu espacio',
    schedulePrompt: 'Aparta tu horario',
    staffSingular: 'responsable',
    staffPlural: 'responsables',
  },
};

/** Merges the tenant override with safe, mode-aware defaults. */
export const resolvePublicBookingCopy = (
  mode: string | null | undefined,
  raw: Prisma.JsonValue | null | undefined,
): PublicBookingCopy => {
  const defaults =
    mode === 'resources' || mode === 'fitness'
      ? DEFAULT_PUBLIC_BOOKING_COPY[mode]
      : DEFAULT_PUBLIC_BOOKING_COPY.services;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;

  const overrides = raw as Record<string, unknown>;
  return (Object.keys(defaults) as Array<keyof PublicBookingCopy>).reduce(
    (copy, key) => {
      const value = overrides[key];
      if (typeof value === 'string' && value.trim()) copy[key] = value.trim();
      return copy;
    },
    { ...defaults },
  );
};
