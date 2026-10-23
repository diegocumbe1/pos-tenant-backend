import { Type } from 'class-transformer';
import {
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

  @IsOptional()
  @IsString()
  note?: string;

  // Sesiones que incluye (paquete). Sin dato = las del servicio. null = ilimitado.
  @IsOptional()
  @IsInt()
  @Min(1)
  sessionsTotal?: number | null;

  // El primer pago, si lo hubo en el mismo momento. Puede ser parcial.
  @IsOptional()
  @ValidateNested()
  @Type(() => BarberPaymentInputDto)
  payment?: BarberPaymentInputDto;
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
  @IsInt()
  @Min(1)
  @Max(365)
  days!: number;

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
