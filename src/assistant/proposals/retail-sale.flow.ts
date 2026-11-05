import { BadRequestException, Injectable } from '@nestjs/common';
import {
  addCalendarDaysCO,
  calendarDayCO,
  dayStartCO,
  formatCOP,
  formatDateLongCO,
} from '../../common/date.util';
import { CaptureOrigin } from '../../common/capture-origin';
import { PrismaService } from '../../prisma/prisma.service';
import { RetailCatalogService } from '../../retail/modules/catalog/retail-catalog.service';
import { RetailCustomersService } from '../../retail/modules/customers/retail-customers.service';
import { CreateRetailSaleDto } from '../../retail/modules/sales/dto/retail-sale.dto';
import { RetailPaymentCommitmentsService } from '../../retail/modules/sales/retail-payment-commitments.service';
import { RetailSalesService } from '../../retail/modules/sales/retail-sales.service';
import { AssistantScopeService } from '../assistant-scope.service';
import { AgentIntent } from '../intents/intent-resolver.service';
import { ambiguousOptions } from './expense.flow';
import { parseAmount } from './expense-capture';
import { normalizeCommand } from './proposal-commands';
import {
  FlowExecution,
  FlowPayload,
  FlowStep,
  Option,
  ProposalFlow,
  ProposalScope,
  askStep,
  hasPermission,
  isOtherQuestion,
  pickOption,
} from './proposal-flow';
import {
  METHOD_LABELS,
  SaleMethod,
  matchProducts,
  parseDueDate,
  parseMethod,
  parseSaleLine,
  parseSaleMessage,
  tokensOf,
  variantFits,
} from './retail-sale-capture';

interface SaleLine {
  /** Lo que se dijo. Se usa hasta resolverlo contra el catálogo. */
  text: string;
  quantity?: number;
  productId?: string;
  name?: string;
  variantId?: string;
  variantLabel?: string;
  /** Lo que se dijo y no está en el nombre del producto. Null = ya se revisó. */
  leftover?: string[] | null;
  unitPriceCOP?: number;
}

export interface RetailSalePayload extends FlowPayload {
  lines: SaleLine[];
  /** true = pagó completo. false = queda saldo. */
  paid?: boolean;
  /** true = se lo llevó. false = se entrega luego. */
  delivered?: boolean;
  depositCOP?: number;
  method?: SaleMethod;
  customerId?: string;
  customerName?: string;
  /** Se crea al confirmar, no antes. */
  newCustomerName?: string;
  customerHint?: string;
  /** Día de pago. Null = el cliente no sabe: no se pacta compromiso. */
  dueOn?: string | null;
  soldDay: string;
  wholesale: boolean;
  deliveryNote?: string;
  price?: { amountCOP: number; per: 'unit' | 'total' };
  mostrador?: 'financing' | 'split';
  branchName?: string;
  branchIdChosen?: string;
  lineIndex?: number;
  totalCOP?: number;
  warnings?: string[];
}

interface CatalogVariant {
  id: string;
  label: string;
  stock: number;
}

interface CatalogProduct {
  id: string;
  name: string;
  priceCOP: number;
  minPriceCOP?: number | null;
  wholesalePrice6COP?: number | null;
  wholesalePrice12COP?: number | null;
  trackStock: boolean;
  availableStock: number;
  stockOptionId?: string | null;
  stockOptionIds?: string[];
  variants: CatalogVariant[];
  isActive: boolean;
  isOverAssigned?: boolean;
}

const WRITE_PERMISSION = 'retail:sales:write';
const CUSTOMER_PERMISSION = 'retail:customers:write';
const NEW_CUSTOMER = '__new__';
const OTHER_CUSTOMER = '__other__';
const MOSTRADOR_METHOD = '__mostrador__';
const NOTHING = /^(?:no|nada|cero|0|ninguno|sin abono|no dejo nada|no dejo)$/;
const MAX_MENU = 12;

const FORM_OPTIONS: Option[] = [
  { value: 'paid_now', label: 'Pagó y se lo llevó' },
  { value: 'paid_later', label: 'Pagó y se entrega luego' },
  { value: 'debt_now', label: 'Se lo llevó y queda debiendo' },
  { value: 'layaway', label: 'Separado: ni pagó ni se lo llevó' },
];

const METHOD_OPTIONS: Option[] = [
  ...(['CASH', 'TRANSFER', 'CARD', 'OTHER'] as SaleMethod[]).map((value) => ({
    value,
    label: METHOD_LABELS[value],
  })),
  { value: MOSTRADOR_METHOD, label: 'Financiación o pago repartido' },
];

const reparte = (product: CatalogProduct) =>
  product.trackStock &&
  (!!product.stockOptionId || (product.stockOptionIds ?? []).length > 0);

const lineTitle = (line: SaleLine) =>
  `${line.name ?? line.text}${line.variantLabel ? ` · ${line.variantLabel}` : ''}`;

/** Igual que el mostrador: el escalón se mide sobre el pedido completo. */
function listPrice(product: CatalogProduct, wholesale: boolean, units: number) {
  if (wholesale) {
    if (units >= 12 && typeof product.wholesalePrice12COP === 'number') {
      return product.wholesalePrice12COP;
    }
    if (units >= 6 && typeof product.wholesalePrice6COP === 'number') {
      return product.wholesalePrice6COP;
    }
  }
  return product.priceCOP;
}

/**
 * Venta de retail por conversación. Toda venta es una de cuatro formas, porque
 * pago y entrega son independientes: el separado no es un estado, son los dos
 * pendientes a la vez.
 *
 * El orden de las preguntas importa: la forma va antes que la opción y el stock
 * porque una venta con entrega pendiente no exige ninguno de los dos.
 *
 * Lynko no valida por el backend, repite lo que él va a exigir para no prometer
 * lo que se rechazaría. Al confirmar decide `createSale`, y si dice que no, se
 * muestra su mensaje.
 */
@Injectable()
export class RetailSaleFlow implements ProposalFlow<RetailSalePayload> {
  readonly kind = 'retail_sale';
  readonly intent: AgentIntent = 'capture_sale';
  readonly permission = WRITE_PERMISSION;
  readonly permissionDenied =
    'Tu usuario no tiene permiso para registrar ventas.';
  readonly words = { this: 'esta', verb: 'registrarla', the: 'la' };
  readonly noAnswers = ['deposit'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: AssistantScopeService,
    private readonly catalog: RetailCatalogService,
    private readonly customers: RetailCustomersService,
    private readonly sales: RetailSalesService,
    private readonly commitments: RetailPaymentCommitmentsService,
  ) {}

  guard(scope: ProposalScope): string | null {
    return (scope.business.vertical?.code ?? '').toLowerCase() === 'retail'
      ? null
      : `${scope.business.name} no registra ventas de tienda. Puedo registrar gastos: "gasté 50 mil en domicilios".`;
  }

  start(message: string): RetailSalePayload {
    const today = calendarDayCO(new Date());
    const parsed = parseSaleMessage(message, today);
    return {
      lines: parsed.lines.map((line) => ({ ...line })),
      soldDay: parsed.daysAgo
        ? addCalendarDaysCO(today, -parsed.daysAgo)
        : today,
      wholesale: parsed.wholesale,
      paid: parsed.paid,
      delivered: parsed.delivered,
      depositCOP: parsed.depositCOP,
      method: parsed.method,
      customerHint: parsed.customer,
      dueOn: parsed.dueOn === 'none' ? null : parsed.dueOn,
      deliveryNote: parsed.deliveryNote,
      price: parsed.price,
      mostrador: parsed.needsMostrador,
    };
  }

  applyAnswer(
    payload: RetailSalePayload,
    message: string,
    intent: AgentIntent,
  ): RetailSalePayload | null {
    const base = { ...payload, options: undefined };
    const picked = () => pickOption(message, payload.options ?? []);
    const line = payload.lines[payload.lineIndex ?? 0];
    const withLine = (patch: Partial<SaleLine>) => ({
      ...base,
      lines: payload.lines.map((row, index) =>
        index === (payload.lineIndex ?? 0) ? { ...row, ...patch } : row,
      ),
    });

    switch (payload.awaiting) {
      case 'branch': {
        const option = picked();
        return option
          ? { ...base, branchName: option.label, branchIdChosen: option.value }
          : null;
      }
      case 'product': {
        if (isOtherQuestion(message, intent)) return null;
        const added = parseSaleLine(message);
        return added ? { ...base, lines: [...payload.lines, added] } : null;
      }
      case 'pick_product': {
        const option = picked();
        return option
          ? withLine({ productId: option.value, name: option.label })
          : null;
      }
      case 'quantity': {
        const parsed = parseSaleLine(`${message.trim()} x`);
        return parsed?.quantity
          ? withLine({ quantity: parsed.quantity })
          : null;
      }
      case 'form': {
        const option = picked();
        if (!option) return null;
        return {
          ...base,
          paid: option.value.startsWith('paid'),
          delivered: option.value.endsWith('now'),
        };
      }
      case 'paid': {
        const option = picked();
        return option ? { ...base, paid: option.value === 'paid' } : null;
      }
      case 'price': {
        const option = picked();
        return option
          ? {
              ...base,
              price: { amountCOP: Number(option.value), per: 'unit' },
            }
          : null;
      }
      case 'deposit': {
        const option = payload.options?.length ? picked() : null;
        if (option) return { ...base, depositCOP: Number(option.value) };
        if (NOTHING.test(normalizeCommand(message))) {
          return { ...base, depositCOP: 0 };
        }
        const amount = parseAmount(message);
        if (!amount) return null;
        return amount.ambiguous
          ? { ...payload, options: ambiguousOptions(amount.amountCOP) }
          : { ...base, depositCOP: amount.amountCOP };
      }
      case 'deposit_total': {
        const option = picked();
        if (!option) return null;
        return option.value === 'paid'
          ? { ...base, paid: true, depositCOP: undefined }
          : { ...base, depositCOP: undefined };
      }
      case 'method': {
        const option = picked();
        if (option?.value === MOSTRADOR_METHOD) {
          return { ...base, mostrador: 'split' };
        }
        const method = (option?.value as SaleMethod) ?? parseMethod(message);
        return method ? { ...base, method } : null;
      }
      case 'customer': {
        if (isOtherQuestion(message, intent)) return null;
        const name = message.replace(/\s+/g, ' ').trim().slice(0, 80);
        return /\p{L}/u.test(name) ? { ...base, customerHint: name } : null;
      }
      case 'customer_pick': {
        const option = picked();
        if (!option) return null;
        if (option.value === OTHER_CUSTOMER) {
          return { ...base, customerHint: undefined, customerId: undefined };
        }
        if (option.value === NEW_CUSTOMER) {
          return {
            ...base,
            newCustomerName: payload.customerHint,
            customerName: payload.customerHint,
            customerHint: undefined,
          };
        }
        return {
          ...base,
          customerId: option.value,
          customerName: option.label.split(' · ')[0],
          customerHint: undefined,
        };
      }
      case 'due': {
        const day = parseDueDate(message, calendarDayCO(new Date()));
        if (!day) return null;
        return { ...base, dueOn: day === 'none' ? null : day };
      }
      case 'variant': {
        const option = picked();
        return option
          ? withLine({
              variantId: option.value,
              variantLabel: option.label,
              leftover: null,
            })
          : null;
      }
      case 'leftover': {
        return picked() ? withLine({ leftover: null }) : null;
      }
      case 'stock': {
        const option = picked();
        if (!option || !line) return null;
        if (option.value === 'later') return { ...base, delivered: false };
        if (option.value === 'cancel')
          return { ...base, awaiting: 'cancelled' };
        const quantity = Number(option.value);
        return quantity > 0
          ? withLine({ quantity })
          : {
              ...base,
              lines: payload.lines.filter((row) => row !== line),
            };
      }
      default:
        return null;
    }
  }

  async next(
    current: RetailSalePayload,
    scope: ProposalScope,
    rowBranchId: string | null,
  ): Promise<FlowStep<RetailSalePayload>> {
    if (current.awaiting === 'cancelled') {
      return {
        type: 'abort',
        text: 'Listo, lo dejé así. No se registró nada.',
      };
    }
    if (current.mostrador) {
      return {
        type: 'abort',
        text:
          current.mostrador === 'financing'
            ? 'Una venta financiada se registra en el Mostrador, porque necesita el convenio y el código de autorización. No registré nada.'
            : 'Un pago repartido entre varios medios se registra en el Mostrador, para que la caja cuadre por cada uno. No registré nada.',
      };
    }

    const payload: RetailSalePayload = {
      ...current,
      lines: current.lines.map((line) => ({ ...line })),
    };
    let branchId = payload.branchIdChosen ?? rowBranchId;
    delete payload.branchIdChosen;

    // ── Sede: cada una tiene su propio catálogo ──────────────────────────────
    if (!branchId) {
      const branches = await this.branchesFor(scope);
      if (!branches.length) {
        return {
          type: 'abort',
          text: 'Tu usuario no tiene ninguna sede para registrar ventas.',
        };
      }
      if (branches.length > 1) {
        return askStep(
          payload,
          null,
          'branch',
          '¿En cuál sede fue la venta?',
          branches.map((b) => ({ value: b.id, label: b.name })),
        );
      }
      branchId = branches[0].id;
    }
    const ask = (awaiting: string, text: string, options?: Option[]) =>
      askStep(
        { ...payload, options: undefined },
        branchId,
        awaiting,
        text,
        options,
      );

    const ctx = await this.scope.contextFor(
      scope.actor,
      scope.business.id,
      branchId,
    );
    const products = (
      (await this.catalog.listProducts(ctx, {
        withVariants: true,
      })) as unknown as CatalogProduct[]
    ).filter((product) => product.isActive);
    const byId = new Map(products.map((product) => [product.id, product]));

    // ── Qué se vendió ────────────────────────────────────────────────────────
    let notice: string | undefined = payload.notice;
    for (let index = 0; index < payload.lines.length; index++) {
      const line = payload.lines[index];
      if (line.productId) continue;
      const matches = matchProducts(line.text, products);
      if (!matches.length) {
        notice = `No encontré "${line.text}" en el catálogo.`;
        payload.lines.splice(index, 1);
        index--;
        continue;
      }
      if (matches.length === 1) {
        line.productId = matches[0].product.id;
        line.name = matches[0].product.name;
        continue;
      }
      if (matches.length > 6) {
        notice = `Hay ${matches.length} productos que coinciden con "${line.text}". Dime el nombre más completo.`;
        payload.lines.splice(index, 1);
        index--;
        continue;
      }
      payload.lineIndex = index;
      payload.notice = notice;
      return ask(
        'pick_product',
        `¿Cuál "${line.text}"?`,
        matches.map((m) => ({ value: m.product.id, label: m.product.name })),
      );
    }
    payload.notice = notice;

    if (!payload.lines.length) {
      return ask(
        'product',
        '¿Qué vendiste y cuántos? Por ejemplo: 2 mantequillas de coco.',
      );
    }

    for (let index = 0; index < payload.lines.length; index++) {
      const line = payload.lines[index];
      const product = byId.get(line.productId as string);
      if (!product) {
        return {
          type: 'abort',
          text: `"${line.name}" ya no está disponible. No registré nada.`,
        };
      }
      if (line.leftover === undefined) {
        const name = new Set(tokensOf(product.name));
        line.leftover = tokensOf(line.text).filter((token) => !name.has(token));
      }
      if (!line.quantity) {
        payload.lineIndex = index;
        return ask('quantity', `¿Cuántas unidades de ${product.name}?`);
      }
    }

    // ── Cómo queda ───────────────────────────────────────────────────────────
    if (payload.paid === undefined && payload.delivered === undefined) {
      return ask('form', '¿Cómo queda esta venta?', FORM_OPTIONS);
    }
    if (payload.paid === undefined) {
      return ask('paid', '¿Ya pagó?', [
        { value: 'paid', label: 'Sí, pagó completo' },
        { value: 'debt', label: 'No, queda debiendo' },
      ]);
    }
    // Si no se dijo nada de la entrega, igual que en el mostrador: se lo llevó.
    // El borrador lo muestra para poder corregirlo.
    if (payload.delivered === undefined) payload.delivered = true;

    // ── Precio ───────────────────────────────────────────────────────────────
    const units = payload.lines.reduce(
      (sum, line) => sum + (line.quantity ?? 0),
      0,
    );
    if (payload.price) {
      if (payload.lines.length > 1) {
        return {
          type: 'abort',
          text: 'Una venta de varios productos con precio especial se registra en el Mostrador. No registré nada.',
        };
      }
      const [line] = payload.lines;
      const product = byId.get(line.productId as string) as CatalogProduct;
      const unit =
        payload.price.per === 'unit'
          ? payload.price.amountCOP
          : payload.price.amountCOP / (line.quantity as number);
      if (!Number.isInteger(unit)) {
        return {
          type: 'abort',
          text: `${formatCOP(payload.price.amountCOP)} no se reparte exacto entre ${line.quantity} unidades. Regístrala en el Mostrador con un descuento. No registré nada.`,
        };
      }
      if (product.minPriceCOP && unit < product.minPriceCOP) {
        payload.notice = `El precio mínimo de ${product.name} es ${formatCOP(product.minPriceCOP)}.`;
        return ask('price', '¿Con cuál precio la registro?', [
          {
            value: String(product.priceCOP),
            label: `Precio de lista: ${formatCOP(product.priceCOP)}`,
          },
          {
            value: String(product.minPriceCOP),
            label: `Precio mínimo: ${formatCOP(product.minPriceCOP)}`,
          },
        ]);
      }
      line.unitPriceCOP = unit;
    } else {
      for (const line of payload.lines) {
        line.unitPriceCOP = listPrice(
          byId.get(line.productId as string) as CatalogProduct,
          payload.wholesale,
          units,
        );
      }
    }
    const totalCOP = payload.lines.reduce(
      (sum, line) => sum + (line.unitPriceCOP ?? 0) * (line.quantity ?? 0),
      0,
    );
    payload.totalCOP = totalCOP;

    // ── Plata ────────────────────────────────────────────────────────────────
    if (payload.paid) {
      payload.depositCOP = undefined;
      payload.dueOn = undefined;
    } else {
      if (payload.depositCOP === undefined) {
        return this.depositQuestion(payload, branchId, totalCOP);
      }
      if (payload.depositCOP >= totalCOP && totalCOP > 0) {
        return ask(
          'deposit_total',
          `Un abono de ${formatCOP(payload.depositCOP)} cubre el total de ${formatCOP(totalCOP)}.`,
          [
            { value: 'paid', label: 'En realidad pagó completo' },
            { value: 'change', label: 'Cambiar el abono' },
          ],
        );
      }
    }
    if ((payload.paid || (payload.depositCOP ?? 0) > 0) && !payload.method) {
      return ask('method', '¿Cómo pagó?', METHOD_OPTIONS);
    }

    // ── Cliente: sin él no hay a quién cobrarle ni entregarle ────────────────
    const needsCustomer = !payload.paid || payload.delivered === false;
    if (!payload.customerId && !payload.newCustomerName) {
      if (payload.customerHint) {
        const step = await this.resolveCustomer(payload, scope, ctx, branchId);
        if (step) return step;
      } else if (needsCustomer) {
        return ask('customer', '¿A nombre de quién queda?');
      }
    }

    // ── Fecha estimada: siempre que quede saldo ──────────────────────────────
    if (!payload.paid && payload.dueOn === undefined) {
      return ask(
        'due',
        '¿Para qué fecha estima pagar? Por ejemplo: el viernes, el 15 o la quincena. Si no sabe, responde SIN FECHA.',
      );
    }

    // ── Opción (aroma, talla) ────────────────────────────────────────────────
    for (let index = 0; index < payload.lines.length; index++) {
      const line = payload.lines[index];
      const product = byId.get(line.productId as string) as CatalogProduct;
      if (line.variantId) continue;
      payload.lineIndex = index;
      const leftover = line.leftover ?? [];
      const variants = product.variants ?? [];
      const toOption = (variant: CatalogVariant): Option => ({
        value: variant.id,
        label: variant.label,
      });

      if (leftover.length && variants.length) {
        const fits = variants.filter((variant) =>
          variantFits(variant.label, leftover),
        );
        if (fits.length === 1) {
          line.variantId = fits[0].id;
          line.variantLabel = fits[0].label;
          line.leftover = null;
          continue;
        }
        if (fits.length > 1) {
          return ask(
            'variant',
            `¿Cuál de ${product.name}?`,
            fits.slice(0, MAX_MENU).map(toOption),
          );
        }
        payload.notice = `No tengo "${leftover.join(' ')}" en ${product.name}.`;
        return ask(
          'variant',
          'Las opciones que sí manejas son:',
          variants.slice(0, MAX_MENU).map(toOption),
        );
      }
      if (leftover.length) {
        payload.notice = `${product.name} no maneja "${leftover.join(' ')}".`;
        return ask('leftover', '¿La registro así?', [
          { value: 'yes', label: `Sí, ${product.name} sin eso` },
        ]);
      }
      if (reparte(product) && payload.delivered && variants.length) {
        return ask(
          'variant',
          `¿Cuál de ${product.name}?`,
          variants.slice(0, MAX_MENU).map(toOption),
        );
      }
    }

    // ── Stock: solo si se lo lleva ahora ─────────────────────────────────────
    if (payload.delivered) {
      const requested = new Map<string, number>();
      for (const line of payload.lines) {
        const key = `${line.productId}|${line.variantId ?? ''}`;
        requested.set(
          key,
          (requested.get(key) ?? 0) + (line.quantity as number),
        );
      }
      for (let index = 0; index < payload.lines.length; index++) {
        const line = payload.lines[index];
        const product = byId.get(line.productId as string) as CatalogProduct;
        if (!product.trackStock) continue;
        const key = `${line.productId}|${line.variantId ?? ''}`;
        const wanted = requested.get(key) as number;
        const variant = product.variants.find(
          (row) => row.id === line.variantId,
        );
        const available = variant ? variant.stock : product.availableStock;
        if (wanted <= available) continue;

        payload.lineIndex = index;
        const reduced = (line.quantity as number) - (wanted - available);
        payload.notice = `De ${lineTitle(line)} hay ${available} disponibles y pediste ${wanted}.`;
        return ask('stock', '¿Qué hago?', [
          ...(reduced > 0
            ? [{ value: String(reduced), label: `Preparar con ${reduced}` }]
            : []),
          {
            value: 'later',
            label: `Dejarla como encargo (${wanted})`,
          },
          { value: 'cancel', label: 'Cancelar' },
        ]);
      }
    }

    // ── Listo ────────────────────────────────────────────────────────────────
    const warnings = payload.lines.flatMap((line) => {
      const product = byId.get(line.productId as string) as CatalogProduct;
      return product.isOverAssigned
        ? [
            `Ojo: el conteo de ${product.name} está descuadrado entre sus opciones.`,
          ]
        : [];
    });
    const ready: RetailSalePayload = {
      ...payload,
      awaiting: undefined,
      options: undefined,
      notice: undefined,
      lineIndex: undefined,
      warnings,
    };
    return {
      type: 'ready',
      payload: ready,
      branchId,
      lines: this.previewLines(ready, scope),
    };
  }

  summary(payload: RetailSalePayload): string {
    const who = payload.customerName ? ` a ${payload.customerName}` : '';
    return `venta de ${formatCOP(payload.totalCOP ?? 0)}${who}`;
  }

  async execute(
    payload: RetailSalePayload,
    scope: ProposalScope,
    branchId: string,
    code: string,
    origin: CaptureOrigin,
  ): Promise<FlowExecution> {
    const ctx = await this.scope.contextFor(
      scope.actor,
      scope.business.id,
      branchId,
    );

    let customerId = payload.customerId;
    if (payload.newCustomerName) {
      if (!(await hasPermission(this.scope, scope, CUSTOMER_PERMISSION))) {
        throw new BadRequestException('Tu usuario no puede crear clientes.');
      }
      const created = await this.customers.createCustomer(ctx, {
        name: payload.newCustomerName,
      });
      customerId = created.id;
    }

    const deposit = payload.depositCOP ?? 0;
    const dto: CreateRetailSaleDto = {
      items: payload.lines.map((line) => ({
        productId: line.productId as string,
        variantId: line.variantId,
        quantity: line.quantity as number,
        unitPriceCOP: line.unitPriceCOP,
      })),
      customerId,
      paymentMethod: payload.method,
      saleType: payload.wholesale ? 'WHOLESALE' : 'RETAIL',
      deliveryStatus: payload.delivered ? 'DELIVERED' : 'PENDING',
      paymentStatus: payload.paid ? 'PAID' : 'PENDING',
      ...(deposit > 0
        ? { depositCOP: deposit, depositMethod: payload.method }
        : {}),
      deliveryNote: payload.delivered ? undefined : payload.deliveryNote,
      // Igual que el mostrador: solo viaja si de verdad es otro día.
      soldAt:
        payload.soldDay !== calendarDayCO(new Date())
          ? payload.soldDay
          : undefined,
    };
    const sale = await this.sales.createSale(ctx, dto, origin);

    const base = `Listo. Quedó registrada la venta ${sale.code} de ${formatCOP(payload.totalCOP ?? 0)}${payload.customerName ? ` a ${payload.customerName}` : ''}, del borrador ${code}.`;
    if (payload.paid || !payload.dueOn) {
      return { resultRef: sale.id, reply: base };
    }

    // La venta ya existe: si la fecha falla, se dice y no se deshace la venta.
    try {
      await this.commitments.create(ctx, {
        saleIds: [sale.id],
        dueOn: payload.dueOn,
      });
      return {
        resultRef: sale.id,
        reply: `${base}\nPaga el ${formatDateLongCO(dayStartCO(payload.dueOn))}.`,
      };
    } catch (error) {
      return {
        resultRef: sale.id,
        reply: `${base}\nPero no pude guardar la fecha de pago: ${(error as Error).message}. Páctala desde Ventas abiertas → Por cobrar → Pactar fecha.`,
      };
    }
  }

  // ─── Apoyos ───────────────────────────────────────────────────────────────

  private depositQuestion(
    payload: RetailSalePayload,
    branchId: string,
    totalCOP: number,
  ): FlowStep<RetailSalePayload> {
    const step = askStep(
      payload,
      branchId,
      'deposit',
      `El total es ${formatCOP(totalCOP)}. ¿Dejó algún abono? Escribe el valor, o NO si no dejó nada.`,
    );
    // Aquí "no" es una respuesta, así que para salir se usa otra palabra.
    return step.type === 'ask'
      ? {
          ...step,
          text: step.text.replace('responde NO.', 'responde CANCELAR.'),
        }
      : step;
  }

  /** Null si quedó resuelto; si no, la pregunta que hay que hacer. */
  private async resolveCustomer(
    payload: RetailSalePayload,
    scope: ProposalScope,
    ctx: Awaited<ReturnType<AssistantScopeService['contextFor']>>,
    branchId: string,
  ): Promise<FlowStep<RetailSalePayload> | null> {
    const hint = payload.customerHint as string;
    const wanted = tokensOf(hint);
    const fits = (name: string) => {
      const tokens = new Set(tokensOf(name));
      return wanted.length > 0 && wanted.every((token) => tokens.has(token));
    };
    // Primero se busca como escribieron; si no aparece, entre los recientes y sin
    // tildes: "Maria" tiene que encontrar a "María".
    let found = (await this.customers.listCustomers(ctx, hint)).filter((c) =>
      fits(c.name),
    );
    if (!found.length) {
      found = (await this.customers.listCustomers(ctx)).filter((c) =>
        fits(c.name),
      );
    }

    if (found.length === 1) {
      payload.customerId = found[0].id;
      payload.customerName = found[0].name;
      payload.customerHint = undefined;
      return null;
    }
    const clean = { ...payload, options: undefined };
    if (found.length > 5) {
      return askStep(
        { ...clean, customerHint: undefined },
        branchId,
        'customer',
        `Hay ${found.length} clientes con "${hint}". Escribe el nombre completo.`,
      );
    }
    if (found.length > 1) {
      return askStep(
        clean,
        branchId,
        'customer_pick',
        `¿Cuál ${hint}?`,
        found.map((c) => ({
          value: c.id,
          label: c.phone
            ? `${c.name} · termina en ${c.phone.slice(-4)}`
            : c.name,
        })),
      );
    }

    const canCreate = await hasPermission(
      this.scope,
      scope,
      CUSTOMER_PERMISSION,
    );
    if (!canCreate) {
      return askStep(
        {
          ...clean,
          customerHint: undefined,
          notice: `No encontré a "${hint}" y tu usuario no puede crear clientes.`,
        },
        branchId,
        'customer',
        '¿A nombre de cuál cliente queda?',
      );
    }
    return askStep(
      { ...clean, notice: `No encontré a "${hint}" en tus clientes.` },
      branchId,
      'customer_pick',
      '¿Qué hago?',
      [
        { value: NEW_CUSTOMER, label: `Crear el cliente ${hint}` },
        { value: OTHER_CUSTOMER, label: 'Escribir otro nombre' },
      ],
    );
  }

  private previewLines(
    payload: RetailSalePayload,
    scope: ProposalScope,
  ): string[] {
    const total = payload.totalCOP ?? 0;
    const deposit = payload.depositCOP ?? 0;
    const methodLabel = payload.method ? METHOD_LABELS[payload.method] : '';
    const today = calendarDayCO(new Date());
    const open = (line: SaleLine) =>
      !line.variantId && !payload.delivered && line.leftover === null;
    return [
      `Lynko armó esta venta en ${scope.business.name}:`,
      ...payload.lines.map(
        (line) =>
          `${line.quantity} × ${lineTitle(line)}: *${formatCOP((line.unitPriceCOP ?? 0) * (line.quantity ?? 0))}*${open(line) ? ' (la opción se define al entregar)' : ''}`,
      ),
      ...(payload.lines.length > 1 ? [`Total: *${formatCOP(total)}*`] : []),
      ...(payload.wholesale ? ['Precio: mayorista'] : []),
      ...(payload.newCustomerName
        ? [`Cliente nuevo: ${payload.newCustomerName}`]
        : payload.customerName
          ? [`Cliente: ${payload.customerName}`]
          : []),
      ...(payload.paid
        ? [`Pago: completo por ${methodLabel.toLowerCase()}`]
        : deposit > 0
          ? [
              `Abono: ${formatCOP(deposit)} por ${methodLabel.toLowerCase()}`,
              `Saldo: *${formatCOP(total - deposit)}*`,
            ]
          : [`Pago: queda debiendo *${formatCOP(total)}*`]),
      payload.delivered
        ? 'Entrega: se lo llevó'
        : `Entrega: se entrega luego${payload.deliveryNote ? ` (${payload.deliveryNote})` : ''}`,
      ...(payload.paid
        ? []
        : [
            payload.dueOn
              ? `Paga el: ${formatDateLongCO(dayStartCO(payload.dueOn))}`
              : 'Fecha de pago: sin fecha',
          ]),
      ...(payload.soldDay !== today
        ? [
            `Fecha de la venta: ${formatDateLongCO(dayStartCO(payload.soldDay))}`,
          ]
        : []),
      ...(payload.branchName ? [`Sede: ${payload.branchName}`] : []),
      ...(payload.warnings ?? []),
    ];
  }

  private branchesFor(scope: ProposalScope) {
    const { actor, business } = scope;
    return this.prisma.branch.findMany({
      where: {
        tenantId: business.id,
        ...(actor.isRoot ? {} : { id: { in: actor.accessibleBranches } }),
      },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}
