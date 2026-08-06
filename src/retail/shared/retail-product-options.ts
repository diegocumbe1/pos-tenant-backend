/**
 * Opciones de presentación de un producto de tienda: color, talla o cualquier
 * grupo que el admin defina. Viven en `RetailProduct.options` (JSONB) porque son
 * configuración de catálogo, no inventario: el stock y el SKU siguen siendo del
 * producto. Una variante con existencias propias sería otra tabla y arrastraría
 * POS, kardex y ventas.
 *
 * Regla de producto: si el admin no configuró opciones, el catálogo (interno y
 * público) no muestra ningún selector. Nada se inventa por defecto.
 */

export type RetailOptionKind = 'color' | 'size' | 'custom';

export type RetailProductOptionValue = {
  id: string;
  /** Lo que se marca al pedir: "Negro", "M", "38". */
  label: string;
  /** Copy del admin: la descripción que acompaña al valor en el sitio. */
  copy: string | null;
  /** Muestra de color (#rrggbb). Solo tiene sentido en grupos de tipo color. */
  hex: string | null;
  /**
   * Fotos del producto que corresponden a este valor. Son un subconjunto de
   * `RetailProduct.imageUrls`: al elegir el color, la galería se filtra a estas.
   * Vacío = el valor no tiene fotos propias y se ven todas.
   */
  imageUrls: string[];
  /** Agotado ese color/talla sin ocultar el producto entero. */
  isAvailable: boolean;
};

export type RetailProductOption = {
  id: string;
  kind: RetailOptionKind;
  /** Título del grupo tal como lo ve el cliente: "Color", "Talla". */
  label: string;
  /** El cliente debe elegir un valor antes de poder agregar al pedido. */
  required: boolean;
  values: RetailProductOptionValue[];
};

const OPTION_KINDS: RetailOptionKind[] = ['color', 'size', 'custom'];
const HEX = /^#[0-9a-fA-F]{6}$/;

const trim = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

/**
 * Normaliza lo que llega del cliente antes de guardarlo. El DTO ya validó tipos;
 * aquí se aplican las reglas de negocio que no se pueden expresar en el DTO:
 *
 * - las fotos de cada valor deben existir en el producto (si el admin borró una
 *   foto, la referencia muere con ella en vez de quedar apuntando a un 404);
 * - un grupo sin valores, o un valor sin etiqueta, no se guarda: sería un
 *   selector vacío en el sitio público;
 * - `hex` solo sobrevive en grupos de color.
 *
 * Devuelve `null` cuando no queda nada que guardar, para que la columna vuelva a
 * NULL y el producto se comporte como uno sin opciones.
 */
export function sanitizeProductOptions(
  input: unknown,
  productImageUrls: string[],
): RetailProductOption[] | null {
  if (!Array.isArray(input)) return null;
  const allowedImages = new Set(productImageUrls);

  const options = input
    .filter((option): option is Record<string, unknown> => Boolean(option))
    .map((option, optionIndex) => {
      const kind = OPTION_KINDS.includes(option.kind as RetailOptionKind)
        ? (option.kind as RetailOptionKind)
        : 'custom';
      const values = (Array.isArray(option.values) ? option.values : [])
        .filter((value): value is Record<string, unknown> => Boolean(value))
        .map((value, valueIndex) => ({
          id: trim(value.id, 40) || `v${valueIndex + 1}`,
          label: trim(value.label, 60),
          copy: trim(value.copy, 200) || null,
          hex:
            kind === 'color' && HEX.test(trim(value.hex, 7))
              ? trim(value.hex, 7).toLowerCase()
              : null,
          imageUrls: (Array.isArray(value.imageUrls) ? value.imageUrls : [])
            .filter(
              (url): url is string =>
                typeof url === 'string' && allowedImages.has(url),
            )
            .slice(0, 20),
          isAvailable: value.isAvailable !== false,
        }))
        .filter((value) => value.label.length > 0);

      return {
        id: trim(option.id, 40) || `opt${optionIndex + 1}`,
        kind,
        label: trim(option.label, 40) || defaultLabel(kind),
        required: option.required === true,
        values,
      };
    })
    .filter((option) => option.values.length > 0)
    .slice(0, 6);

  return options.length > 0 ? options : null;
}

function defaultLabel(kind: RetailOptionKind): string {
  if (kind === 'color') return 'Color';
  if (kind === 'size') return 'Talla';
  return 'Opción';
}

/** Lee la columna JSON con la forma esperada, tolerando filas viejas o corruptas. */
export function readProductOptions(value: unknown): RetailProductOption[] {
  return Array.isArray(value) ? (value as RetailProductOption[]) : [];
}

/**
 * Vista pública de las opciones. Los valores agotados viajan igual (marcados con
 * `isAvailable: false`): el cliente debe ver que ese color existe aunque no se
 * pueda pedir hoy. Lo que sí se omite es el grupo entero cuando ninguno de sus
 * valores está disponible, y `undefined` cuando no queda ningún grupo, para que
 * el sitio no pinte un selector vacío.
 */
export function toPublicProductOptions(
  value: unknown,
): RetailProductOption[] | undefined {
  const options = readProductOptions(value).filter((option) =>
    option.values.some((optionValue) => optionValue.isAvailable),
  );
  return options.length > 0 ? options : undefined;
}
