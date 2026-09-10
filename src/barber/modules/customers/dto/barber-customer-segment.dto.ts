import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Convierte `?serviceIds=a,b,c` (o repetido) en un array limpio. */
const csv = ({ value }: { value: unknown }): string[] | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  // Solo strings: un objeto en el query no es una lista de ids, es basura, y
  // convertirlo daría "[object Object]" como si fuera un id válido.
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const out = raw
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
};

/**
 * Filtros de la lista "por atender".
 *
 * Todo es opcional: sin filtros devuelve los clientes del branch ordenados por
 * quién lleva más tiempo sin volver, que ya es la pregunta útil.
 */
export class BarberCustomerSegmentQueryDto {
  // Clientes que se hicieron ALGUNO de estos servicios (en cualquier momento).
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsString({ each: true })
  serviceIds?: string[];

  // Su último servicio fue ANTES de esta fecha: "no vuelven desde…".
  @IsOptional()
  @IsDateString()
  servedBefore?: string;

  // Su último servicio fue DESPUÉS de esta fecha.
  @IsOptional()
  @IsDateString()
  servedAfter?: string;

  /**
   * Solo los vencidos, según los días configurados en el servicio:
   * - `retouch`: pasó `retouchAfterDays` desde el último servicio.
   * - `maintenance`: pasó `maintenanceAfterDays`.
   * Los servicios sin esos días configurados nunca aparecen como vencidos.
   */
  @IsOptional()
  @IsIn(['retouch', 'maintenance'])
  dueOnly?: 'retouch' | 'maintenance';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minVisits?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxVisits?: number;

  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  // Búsqueda por nombre o teléfono, para no tener que salirse de la pestaña.
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/** Una fila de la lista: el cliente más el porqué está en ella. */
export interface BarberCustomerSegmentRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  tags: string[];
  totalVisits: number;
  /** Último servicio prestado. */
  lastServedAt: Date | null;
  lastServiceId: string | null;
  /** Nombre del servicio al momento de consultar (aún no hay snapshot). */
  lastServiceName: string | null;
  /** Días transcurridos desde ese servicio. */
  daysSinceLastVisit: number | null;
  /** Cuánto cuesta su retoque, si el servicio lo tiene definido. */
  retouchPriceCOP: number | null;
  /** Suma de lo que ha pagado, con los precios congelados de cada cita. */
  totalSpentCOP: number;
  /** `retouch` | `maintenance` | null — qué se le venció, si algo. */
  dueKind: 'retouch' | 'maintenance' | null;
}

export interface BarberCustomerSegmentResult {
  rows: BarberCustomerSegmentRow[];
  total: number;
  /**
   * Cuánto vale la lista completa (no solo la página): la suma de los retoques
   * pendientes. Es el número que convierte la lista en una razón para llamar.
   */
  pendingRetouchCOP: number;
}
