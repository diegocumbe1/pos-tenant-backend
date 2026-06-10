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
} from 'class-validator';

const PLANS = ['BASIC', 'PRO', 'PREMIUM'] as const;
const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED', 'INACTIVE'] as const;
const BILLING_CYCLES = ['monthly', 'yearly'] as const;
const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
const PERIODS = ['today', 'week', 'month', 'custom'] as const;

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

export class CreatePaymentDto {
  @ApiProperty({ example: 129000, description: 'Monto entero' })
  @IsInt()
  @Min(0)
  amount!: number;

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

export class CreatePlatformExpenseDto {
  @ApiProperty({ enum: PLATFORM_EXPENSE_CATEGORIES })
  @IsIn(PLATFORM_EXPENSE_CATEGORIES)
  category!: (typeof PLATFORM_EXPENSE_CATEGORIES)[number];

  @ApiProperty({ example: 'Vercel Pro' })
  @IsString()
  @IsNotEmpty()
  concept!: string;

  @ApiProperty({ example: 95000, description: 'Monto entero' })
  @IsInt()
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({ enum: CURRENCIES, default: 'COP' })
  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: (typeof CURRENCIES)[number];

  @ApiProperty({ example: '2026-06-09T00:00:00.000Z' })
  @IsISO8601()
  incurredAt!: string;

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

  @ApiPropertyOptional({ example: 95000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({ enum: CURRENCIES })
  @IsOptional()
  @IsIn(CURRENCIES)
  currency?: (typeof CURRENCIES)[number];

  @ApiPropertyOptional({ example: '2026-06-09T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  incurredAt?: string;

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
