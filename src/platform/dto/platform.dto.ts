import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';

const PLANS = ['BASIC', 'PRO', 'PREMIUM'] as const;
const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED', 'INACTIVE'] as const;
const BILLING_CYCLES = ['monthly', 'yearly'] as const;
const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
const PERIODS = ['today', 'week', 'month', 'custom'] as const;

export class UpdatePricingConfigDto {
  @ApiPropertyOptional({ example: 4100, description: 'COP por 1 USD' })
  @ValidateIf((dto) => dto.usdToCopRate === undefined)
  @IsInt()
  @Min(1)
  rate?: number;

  @ApiPropertyOptional({
    example: 4100,
    description: 'Alias compatible: COP por 1 USD',
  })
  @ValidateIf((dto) => dto.rate === undefined)
  @IsInt()
  @Min(1)
  usdToCopRate?: number;

  @ApiPropertyOptional({
    description: 'Desde cuándo rige la tasa. Por defecto, ya mismo.',
  })
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @ApiPropertyOptional({
    description: 'Motivo del cambio (queda en histórico)',
  })
  @IsOptional()
  @IsString()
  note?: string;
}

const VERTICALS = ['restaurant', 'barber', 'retail'] as const;

export class CreatePlanPriceDto {
  @ApiProperty({ enum: VERTICALS })
  @IsIn(VERTICALS)
  verticalCode!: string;

  @ApiProperty({ enum: PLANS })
  @IsIn(PLANS)
  planCode!: string;

  @ApiProperty({ example: 33, description: 'Precio de lista mensual en USD' })
  @IsInt()
  @Min(0)
  priceUSD!: number;

  @ApiPropertyOptional({
    description: 'Desde cuándo rige el precio. Por defecto, ya mismo.',
  })
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  @ApiPropertyOptional({
    description: 'Motivo del cambio (queda en histórico)',
  })
  @IsOptional()
  @IsString()
  note?: string;
}

export class PlanPriceHistoryQueryDto {
  @ApiPropertyOptional({ enum: VERTICALS })
  @IsOptional()
  @IsIn(VERTICALS)
  verticalCode?: string;

  @ApiPropertyOptional({ enum: PLANS })
  @IsOptional()
  @IsIn(PLANS)
  planCode?: string;
}

export class UpdatePlanDto {
  @ApiProperty({ enum: PLANS })
  @IsIn(PLANS)
  plan!: (typeof PLANS)[number];
}

export class SetFeatureOverrideDto {
  @ApiProperty({ example: 'kitchenDisplay' })
  @IsString()
  @IsNotEmpty()
  feature!: string;

  // boolean | number | null  (null = quitar override, hereda del plan).
  // @Allow lo whitelistea sin imponer un tipo (la validación fina se hace en el service).
  @ApiProperty({
    description: 'boolean | number | null (null quita el override)',
  })
  @Allow()
  value!: boolean | number | null;
}

export class SetTenantStatusDto {
  @ApiProperty({ enum: TENANT_STATUSES })
  @IsIn(TENANT_STATUSES)
  status!: (typeof TENANT_STATUSES)[number];
}

export class UpdateSubscriptionDto {
  @ApiPropertyOptional({ enum: PLANS })
  @IsOptional()
  @IsIn(PLANS)
  plan?: (typeof PLANS)[number];

  @ApiPropertyOptional({ enum: BILLING_CYCLES })
  @IsOptional()
  @IsIn(BILLING_CYCLES)
  billingCycle?: (typeof BILLING_CYCLES)[number];

  @ApiPropertyOptional({ example: '2026-12-31T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  currentPeriodEnd?: string;

  @ApiPropertyOptional({ example: '2026-12-31T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  nextPaymentDueAt?: string;

  @ApiPropertyOptional({ example: 129000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceCOP?: number;

  @ApiPropertyOptional({ example: 32 })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceUSD?: number;

  // Términos comerciales: lista vs pactado. El descuento se deriva (lista − pactado).
  @ApiPropertyOptional({ example: 130000, description: 'Precio de lista COP' })
  @IsOptional()
  @IsInt()
  @Min(0)
  listPriceCOP?: number;

  @ApiPropertyOptional({ example: 33, description: 'Precio de lista USD' })
  @IsOptional()
  @IsInt()
  @Min(0)
  listPriceUSD?: number;

  @ApiPropertyOptional({ example: 92000, description: 'Precio pactado COP' })
  @IsOptional()
  @IsInt()
  @Min(0)
  agreedPriceCOP?: number;

  @ApiPropertyOptional({ example: 23, description: 'Precio pactado USD' })
  @IsOptional()
  @IsInt()
  @Min(0)
  agreedPriceUSD?: number;

  @ApiPropertyOptional({ example: 'Cliente fundador' })
  @IsOptional()
  @IsString()
  discountReason?: string;

  @ApiPropertyOptional({ example: 'platform-admin' })
  @IsOptional()
  @IsString()
  discountApprovedBy?: string;
}

export class SubscriptionActionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

export class SetUserStatusDto {
  @ApiProperty({ enum: USER_STATUSES })
  @IsIn(USER_STATUSES)
  status!: (typeof USER_STATUSES)[number];
}

const CURRENCIES = ['COP', 'USD'] as const;
const PAYMENT_KINDS = ['payment', 'bonus', 'credit'] as const;

export class CreatePaymentDto {
  @ApiProperty({ example: 129000, description: 'Monto neto recibido' })
  @IsInt()
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({
    enum: PAYMENT_KINDS,
    default: 'payment',
    description:
      "'payment' = plata que entró · 'bonus' = mes de cortesía · 'credit' = nota crédito. bonus/credit NO suman a ingresos.",
  })
  @IsOptional()
  @IsIn(PAYMENT_KINDS)
  kind?: (typeof PAYMENT_KINDS)[number];

  @ApiPropertyOptional({
    example: 130000,
    description: 'Precio de lista del plan al momento del cobro',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  officialPrice?: number;

  @ApiPropertyOptional({
    example: 38000,
    description: 'Descuento/bono aplicado sobre el precio de lista',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  discountApplied?: number;

  @ApiPropertyOptional({ example: 'Cliente fundador' })
  @IsOptional()
  @IsString()
  discountReason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiptUrl?: string;

  @ApiPropertyOptional({ enum: CURRENCIES, default: 'COP' })
  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: (typeof CURRENCIES)[number];

  @ApiPropertyOptional({ enum: BILLING_CYCLES })
  @IsOptional()
  @IsIn(BILLING_CYCLES)
  billingCycle?: (typeof BILLING_CYCLES)[number];

  @ApiProperty({ example: '2026-06-01T00:00:00.000Z' })
  @IsISO8601()
  periodStart!: string;

  @ApiProperty({
    example: '2026-07-01T00:00:00.000Z',
    description:
      'Fin del periodo cubierto; futuro/multi-ciclo = pago anticipado',
  })
  @IsISO8601()
  periodEnd!: string;

  @ApiPropertyOptional({ description: 'Fecha del pago (default: ahora)' })
  @IsOptional()
  @IsISO8601()
  paidAt?: string;

  @ApiPropertyOptional({ example: 'transfer' })
  @IsOptional()
  @IsString()
  method?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Si true, mueve subscription.currentPeriodEnd = periodEnd y reactiva (pago anticipado)',
  })
  @IsOptional()
  @IsBoolean()
  extendPeriod?: boolean;
}

export class UpsertBillingContactDto {
  @ApiProperty({ example: 'Lisdreth Natalia Perilla' })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({ example: 'Dueño' })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiProperty({ example: '+57 312 4758685' })
  @IsString()
  @IsNotEmpty()
  phone!: string;

  @ApiPropertyOptional({ example: '+57 312 4758685' })
  @IsOptional()
  @IsString()
  whatsapp?: string;

  @ApiPropertyOptional({ example: 'ruta43grillburger@gmail.com' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateBillingContactDto {
  @ApiPropertyOptional({ example: 'Lisdreth Natalia Perilla' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({ example: 'Dueño' })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiPropertyOptional({ example: '+57 312 4758685' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  phone?: string;

  @ApiPropertyOptional({ example: '+57 312 4758685' })
  @IsOptional()
  @IsString()
  whatsapp?: string;

  @ApiPropertyOptional({ example: 'ruta43grillburger@gmail.com' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class PlatformFinanceQueryDto {
  @ApiPropertyOptional({ enum: PERIODS, default: 'month' })
  @IsOptional()
  @IsIn(PERIODS)
  period?: (typeof PERIODS)[number];

  @ApiPropertyOptional({
    example: '2026-06-01T00:00:00.000Z',
    description: 'Required when period=custom',
  })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({
    example: '2026-06-30T23:59:59.999Z',
    description: 'Required when period=custom',
  })
  @IsOptional()
  @IsDateString()
  dateTo?: string;
}

export class PlatformFinanceMonthQueryDto {
  @ApiPropertyOptional({ example: '2026-06' })
  @IsOptional()
  @IsString()
  month?: string;
}

const PLATFORM_EXPENSE_CATEGORIES = [
  'infra',
  'marketing',
  'payroll',
  'tools',
  'support',
  'taxes',
  'other',
] as const;

const EXPENSE_KINDS = ['one_time', 'recurring'] as const;
const RECURRENCES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;

export class CreatePlatformExpenseDto {
  @ApiProperty({ enum: PLATFORM_EXPENSE_CATEGORIES })
  @IsIn(PLATFORM_EXPENSE_CATEGORIES)
  category!: (typeof PLATFORM_EXPENSE_CATEGORIES)[number];

  @ApiProperty({ example: 'Vercel Pro' })
  @IsString()
  @IsNotEmpty()
  concept!: string;

  @ApiPropertyOptional({ example: 'Vercel' })
  @IsOptional()
  @IsString()
  vendor?: string;

  @ApiProperty({ example: 95000, description: 'Monto entero' })
  @IsInt()
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({ enum: CURRENCIES, default: 'COP' })
  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: (typeof CURRENCIES)[number];

  @ApiPropertyOptional({ enum: EXPENSE_KINDS, default: 'one_time' })
  @IsOptional()
  @IsIn(EXPENSE_KINDS)
  kind?: (typeof EXPENSE_KINDS)[number];

  @ApiProperty({
    example: '2026-06-09T00:00:00.000Z',
    description: 'Fecha de caja: en qué periodo suma el gasto',
  })
  @IsISO8601()
  incurredAt!: string;

  @ApiPropertyOptional({ description: 'Inicio del periodo que cubre el gasto' })
  @IsOptional()
  @IsISO8601()
  periodStart?: string;

  @ApiPropertyOptional({ description: 'Fin del periodo que cubre el gasto' })
  @IsOptional()
  @IsISO8601()
  periodEnd?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdatePlatformExpenseDto {
  @ApiPropertyOptional({ enum: PLATFORM_EXPENSE_CATEGORIES })
  @IsOptional()
  @IsIn(PLATFORM_EXPENSE_CATEGORIES)
  category?: (typeof PLATFORM_EXPENSE_CATEGORIES)[number];

  @ApiPropertyOptional({ example: 'Vercel Pro' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  concept?: string;

  @ApiPropertyOptional({ example: 'Vercel' })
  @IsOptional()
  @IsString()
  vendor?: string;

  @ApiPropertyOptional({ example: 95000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({ enum: CURRENCIES })
  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: (typeof CURRENCIES)[number];

  @ApiPropertyOptional({ enum: EXPENSE_KINDS })
  @IsOptional()
  @IsIn(EXPENSE_KINDS)
  kind?: (typeof EXPENSE_KINDS)[number];

  @ApiPropertyOptional({ example: '2026-06-09T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  incurredAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  periodStart?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  periodEnd?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

// ─── Gastos recurrentes (compromisos) ────────────────────────────────────────

export class CreateRecurringExpenseDto {
  @ApiProperty({ enum: PLATFORM_EXPENSE_CATEGORIES })
  @IsIn(PLATFORM_EXPENSE_CATEGORIES)
  category!: (typeof PLATFORM_EXPENSE_CATEGORIES)[number];

  @ApiProperty({ example: 'Dominio lynko.com' })
  @IsString()
  @IsNotEmpty()
  concept!: string;

  @ApiPropertyOptional({ example: 'Namecheap' })
  @IsOptional()
  @IsString()
  vendor?: string;

  @ApiProperty({ example: 52000 })
  @IsInt()
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({ enum: CURRENCIES, default: 'COP' })
  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: (typeof CURRENCIES)[number];

  @ApiProperty({ enum: RECURRENCES, default: 'monthly' })
  @IsIn(RECURRENCES)
  recurrence!: (typeof RECURRENCES)[number];

  @ApiProperty({ example: '2026-03-12T00:00:00.000Z' })
  @IsISO8601()
  startsAt!: string;

  @ApiPropertyOptional({ description: 'null/omitido = indefinido' })
  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Generar automáticamente los cobros vencidos',
  })
  @IsOptional()
  @IsBoolean()
  autoGenerate?: boolean;

  @ApiPropertyOptional({
    default: true,
    description:
      'Si true, genera de una el cobro de startsAt (ya se pagó al contratar)',
  })
  @IsOptional()
  @IsBoolean()
  chargeOnCreate?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateRecurringExpenseDto {
  @ApiPropertyOptional({ enum: PLATFORM_EXPENSE_CATEGORIES })
  @IsOptional()
  @IsIn(PLATFORM_EXPENSE_CATEGORIES)
  category?: (typeof PLATFORM_EXPENSE_CATEGORIES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  concept?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({ enum: CURRENCIES })
  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: (typeof CURRENCIES)[number];

  @ApiPropertyOptional({ enum: RECURRENCES })
  @IsOptional()
  @IsIn(RECURRENCES)
  recurrence?: (typeof RECURRENCES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  endsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  nextChargeAt?: string;

  @ApiPropertyOptional({ description: 'false = dar de baja el compromiso' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoGenerate?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

const PLATFORM_GOAL_METRICS = [
  'revenue_cop',
  'profit_cop',
  'mrr_cop',
  'payments_count',
  'active_tenants',
] as const;

export class UpsertPlatformFinanceGoalDto {
  @ApiProperty({ example: '2026-06' })
  @IsString()
  periodMonth!: string;

  @ApiProperty({ enum: PLATFORM_GOAL_METRICS })
  @IsIn(PLATFORM_GOAL_METRICS)
  metric!: (typeof PLATFORM_GOAL_METRICS)[number];

  @ApiProperty({ example: 5000000 })
  @IsInt()
  @Min(0)
  target!: number;
}

export class UpdatePlatformFinanceGoalDto {
  @ApiPropertyOptional({ example: 5000000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  target?: number;
}
