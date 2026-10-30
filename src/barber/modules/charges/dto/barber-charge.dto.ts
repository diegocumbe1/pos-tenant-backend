import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Con qué pagó. Los medios salen de lo que la sede tiene configurado en
 * Ajustes (Branch.paymentInfo), más efectivo siempre:
 *   CASH · BREB · NEQUI · DAVIPLATA · TRANSFER (cuenta bancaria) · QR · CARD ·
 *   OTHER · WALLET:<nombre> (cada billetera configurada, con su nombre, para que
 *   "Nu" no se pierda como "otra billetera").
 */
export const BARBER_PAYMENT_METHOD_RE =
  /^(CASH|BREB|NEQUI|DAVIPLATA|TRANSFER|QR|CARD|OTHER|WALLET:[^\n]{1,40})$/;
export type BarberPaymentMethod = string;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Fecha sola ('2026-10-07') o ISO completo.
const DAY_OR_ISO_RE = /^\d{4}-\d{2}-\d{2}(T.+)?$/;

export class BarberPaymentInputDto {
  @IsInt()
  @Min(1)
  amountCOP!: number;

  @Matches(BARBER_PAYMENT_METHOD_RE)
  method!: BarberPaymentMethod;

  // Cuándo pagó. Sin dato = ahora. 'YYYY-MM-DD' se ancla a la hora actual.
  @IsOptional()
  @Matches(DAY_OR_ISO_RE)
  paidAt?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateBarberChargeDto {
  @IsOptional()
  @IsString()
  customerId?: string;

  // Cobro de una cita: concepto, valor, cliente y servicio salen de ella.
  @IsOptional()
  @IsString()
  appointmentId?: string;

  // Cobro de un servicio sin cita (la mensualidad): concepto y valor salen de él.
  @IsOptional()
  @IsString()
  serviceId?: string;

  // Obligatorio solo si no hay cita ni servicio de donde sacarlo.
  @IsOptional()
  @IsString()
  @MinLength(2)
  concept?: string;

  // Sin dato = el precio de la cita o del servicio.
  @IsOptional()
  @IsInt()
  @Min(0)
  totalCOP?: number;

  @IsOptional()
  @Matches(DAY_OR_ISO_RE)
  chargedAt?: string;

  @IsOptional()
  @Matches(DAY_RE)
  startsOn?: string;

  @IsOptional()
  @Matches(DAY_RE)
  endsOn?: string;

  @IsOptional()
  @Matches(DAY_RE)
  dueOn?: string;

  // Descuento ya restado de `totalCOP`. Se guarda para que el recibo lo muestre.
  @IsOptional()
  @IsInt()
  @Min(0)
  discountCOP?: number;

  @IsOptional()
  @IsString()
  note?: string;

  // Sesiones que incluye (paquete). Sin dato = las del servicio. null = ilimitado.
  @IsOptional()
  @IsInt()
  @Min(1)
  sessionsTotal?: number | null;

  // Cupo por mes de plan. Sin dato = el del servicio. null = sin cupo.
  @IsOptional()
  @IsInt()
  @Min(1)
  sessionsPerMonth?: number | null;

  // El primer pago, si lo hubo en el mismo momento. Puede ser parcial.
  @IsOptional()
  @ValidateNested()
  @Type(() => BarberPaymentInputDto)
  payment?: BarberPaymentInputDto;

  // Pago repartido entre medios (parte en efectivo, parte por transferencia):
  // cada uno queda como un pago aparte. Se suma con `payment` si vienen ambos.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => BarberPaymentInputDto)
  payments?: BarberPaymentInputDto[];
}

export class UpdateBarberChargeDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  totalCOP?: number;

  // null borra la fecha.
  @IsOptional()
  @Matches(DAY_RE)
  startsOn?: string | null;

  @IsOptional()
  @Matches(DAY_RE)
  endsOn?: string | null;

  @IsOptional()
  @Matches(DAY_RE)
  dueOn?: string | null;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  sessionsTotal?: number | null;

  // Cupo por mes de plan. Sin dato = el del servicio. null = sin cupo.
  @IsOptional()
  @IsInt()
  @Min(1)
  sessionsPerMonth?: number | null;
}

export class RenewBarberChargeDto {
  // Sin dato = el precio actual del plan.
  @IsOptional()
  @IsInt()
  @Min(0)
  totalCOP?: number;

  @IsOptional()
  @Matches(DAY_RE)
  dueOn?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => BarberPaymentInputDto)
  payment?: BarberPaymentInputDto;
}

export class FreezeBarberChargeDto {
  // Desde cuándo. Sin dato = hoy.
  @IsOptional()
  @Matches(DAY_RE)
  startsOn?: string;

  // Cuántos días, o hasta qué día (inclusive). Uno de los dos.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;

  @IsOptional()
  @Matches(DAY_RE)
  untilOn?: string;

  @IsString()
  @MinLength(2)
  reason!: string;
}

export class CoverAppointmentDto {
  @IsString()
  appointmentId!: string;
}

export class ListBarberMembershipsQueryDto {
  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'EXPIRING', 'EXPIRED', 'NO_SESSIONS', 'UPCOMING', 'ALL'])
  state?:
    | 'ACTIVE'
    | 'EXPIRING'
    | 'EXPIRED'
    | 'NO_SESSIONS'
    | 'UPCOMING'
    | 'ALL';

  // Ventana de aviso de "por vencer", en días. Por defecto 5.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  days?: number;
}

export class VoidBarberChargeDto {
  @IsString()
  @MinLength(2)
  reason!: string;
}

export class ListBarberChargesQueryDto {
  @IsOptional()
  @Matches(DAY_RE)
  from?: string;

  @IsOptional()
  @Matches(DAY_RE)
  to?: string;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  appointmentId?: string;

  // open = con saldo pendiente (sin importar la fecha).
  @IsOptional()
  @IsIn(['open', 'all'])
  status?: 'open' | 'all';
}

export class BarberAttendanceCheckQueryDto {
  @IsString()
  customerId!: string;

  // Día de la sesión. Sin dato = hoy.
  @IsOptional()
  @Matches(DAY_RE)
  day?: string;

  // La sesión que se va a registrar, si ya existe: no se cuenta contra sí misma.
  @IsOptional()
  @IsString()
  appointmentId?: string;
}

/**
 * Cobrar de una vez las visitas que no cubrió ningún plan.
 *   PER_SESSION → cada visita al valor por sesión del plan (240.000 / 8).
 *   FULL_PLAN   → el plan completo, y esas visitas quedan dentro de él.
 */
export class SettleBarberSessionsDto {
  @IsString()
  customerId!: string;

  // El plan con el que se valoran (y que se contrata, en FULL_PLAN).
  @IsString()
  serviceId!: string;

  @IsIn(['PER_SESSION', 'FULL_PLAN'])
  mode!: 'PER_SESSION' | 'FULL_PLAN';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  appointmentIds!: string[];

  // Sin dato = el calculado (valor por sesión × visitas, o el precio del plan).
  @IsOptional()
  @IsInt()
  @Min(1)
  totalCOP?: number;

  @IsOptional()
  @Matches(DAY_RE)
  dueOn?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => BarberPaymentInputDto)
  payments?: BarberPaymentInputDto[];
}

export class CoverOverQuotaDto {
  @IsString()
  appointmentId!: string;

  @IsIn(['NEXT_CYCLE', 'COURTESY'])
  mode!: 'NEXT_CYCLE' | 'COURTESY';
}
