/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AssistantChannel } from '@prisma/client';
import {
  AgentProposalsService,
  ProposalScope,
} from './agent-proposals.service';
import { ExpenseFlow } from './expense.flow';
import { RetailSaleFlow } from './retail-sale.flow';

/**
 * El camino completo de una venta sobre el motor real, con el backend simulado:
 * qué pregunta, en qué orden, y qué le llega a `createSale` al confirmar.
 */

const SCOPE: ProposalScope = {
  business: { id: 't1', name: 'Bella Chic', vertical: { code: 'retail' } },
  actor: {
    id: 'u1',
    email: 'u1@x.co',
    name: 'Paola',
    tenantId: 't1',
    roleId: 'r1',
    roleCode: 'OWNER',
    isRoot: false,
    isPlatformAdmin: false,
    passwordSetAt: new Date(),
    accessibleBranches: ['b1'],
  },
};
const WHO = {
  channel: AssistantChannel.WHATSAPP,
  externalUserId: '573001234567',
};

const MANTEQUILLA = {
  id: 'p1',
  name: 'Mantequilla Corporal',
  priceCOP: 42_000,
  minPriceCOP: 35_000,
  wholesalePrice6COP: 30_000,
  wholesalePrice12COP: 25_000,
  trackStock: true,
  availableStock: 8,
  stockOptionId: 'opt',
  stockOptionIds: ['opt'],
  isActive: true,
  variants: [
    { id: 'v1', label: 'Coco', stock: 3 },
    { id: 'v2', label: 'Frutos rojos', stock: 5 },
  ],
};
const PERFUME = {
  id: 'p2',
  name: 'Perfume Azul',
  priceCOP: 120_000,
  trackStock: true,
  availableStock: 4,
  stockOptionId: null,
  stockOptionIds: [],
  isActive: true,
  variants: [],
};
const LAURA = { id: 'c1', name: 'Laura Gómez', phone: '3001234567' };

function build(
  options: {
    customers?: unknown[];
    forbid?: string[];
    products?: unknown[];
    vertical?: string;
  } = {},
) {
  const rows: Record<string, any>[] = [];
  const matches = (row: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === 'object' && 'gt' in value
        ? row[key] > (value as { gt: Date }).gt
        : row[key] === value,
    );
  const prisma = {
    agentProposal: {
      create: jest.fn(async ({ data }) => {
        const row = {
          id: `p${rows.length + 1}`,
          status: 'COLLECTING',
          branchId: null,
          confirmCode: null,
          preview: null,
          ...data,
        };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = rows.find((r) => r.id === where.id)!;
        // Igual que JSON: lo `undefined` no se guarda.
        Object.assign(row, JSON.parse(JSON.stringify(data)));
        row.expiresAt = data.expiresAt ?? row.expiresAt;
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const found = rows.filter((r) => matches(r, where));
        found.forEach((r) => Object.assign(r, data));
        return { count: found.length };
      }),
      findFirst: jest.fn(
        async ({ where }) =>
          [...rows].reverse().find((r) => matches(r, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where }) =>
        rows.filter((r) => matches(r, where)),
      ),
    },
    branch: {
      findMany: jest.fn().mockResolvedValue([{ id: 'b1', name: 'Centro' }]),
    },
    moneyAccount: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const scope = {
    contextFor: jest.fn().mockResolvedValue({
      tenantId: 't1',
      branchId: 'b1',
      permissions: new Set(),
    }),
    assertPermission: jest.fn((_ctx, code: string) => {
      if (options.forbid?.includes(code)) throw new ForbiddenException();
    }),
  };
  const catalog = {
    listProducts: jest
      .fn()
      .mockResolvedValue(options.products ?? [MANTEQUILLA, PERFUME]),
  };
  const customers = {
    listCustomers: jest
      .fn()
      .mockImplementation(async () => options.customers ?? [LAURA]),
    createCustomer: jest.fn().mockResolvedValue({ id: 'c9', name: 'Pedro' }),
  };
  const sales = {
    createSale: jest.fn().mockResolvedValue({ id: 's1', code: 'RS-000123' }),
  };
  const commitments = { create: jest.fn().mockResolvedValue({ id: 'cm1' }) };
  const flow = new RetailSaleFlow(
    prisma as never,
    scope as never,
    catalog as never,
    customers as never,
    sales as never,
    commitments as never,
  );
  const service = new AgentProposalsService(
    prisma as never,
    scope as never,
    { get: jest.fn() } as never,
    { assertAvailable: jest.fn() } as never,
    new ExpenseFlow(prisma as never, scope as never, {} as never),
    flow,
  );
  const biz = options.vertical
    ? {
        ...SCOPE,
        business: { ...SCOPE.business, vertical: { code: options.vertical } },
      }
    : SCOPE;
  const start = (message: string) =>
    service.start('retail_sale', { ...WHO, message }, biz);
  const say = async (message: string) =>
    (await service.handle({
      ...WHO,
      message,
      intent: 'unknown',
      scopes: [biz],
    }))!.reply;
  const row = () => rows[rows.length - 1];
  return { start, say, row, sales, commitments, customers, catalog };
}

describe('RetailSaleFlow', () => {
  describe('si dice solo "registrar venta", pregunta lo que falta en orden', () => {
    it('pagó y se lo llevó', async () => {
      const { start, say, row, sales } = build();
      expect((await start('registrar venta')).reply).toContain('¿Qué vendiste');
      const form = await say('2 mantequillas de coco');
      expect(form).toContain('¿Cómo queda esta venta?');
      expect(form).toContain('4. Separado');
      expect(await say('1')).toContain('¿Cómo pagó?');
      const preview = await say('Transferencia');
      expect(preview).toContain('2 × Mantequilla Corporal · Coco');
      expect(preview).toContain('Entrega: se lo llevó');
      expect(preview).toContain(
        `Código de este borrador: *${row().confirmCode}*`,
      );
      expect(sales.createSale).not.toHaveBeenCalled();
    });

    it('no pregunta la opción antes de saber si se lo lleva', async () => {
      const { start, say } = build();
      await start('registrar venta');
      expect(await say('2 mantequillas')).toContain('¿Cómo queda');
    });

    it('fiado: pregunta abono, cliente y fecha estimada', async () => {
      const { start, say } = build();
      await start('vendí 1 perfume');
      await say('3');
      const deposit = await say('hola');
      expect(deposit).toContain('¿Dejó algún abono?');
      expect(await say('no')).toContain('¿A nombre de quién');
      expect(await say('Laura')).toContain('¿Para qué fecha estima pagar?');
      const preview = await say('el 15');
      expect(preview).toContain('queda debiendo');
      expect(preview).toContain('Paga el:');
    });

    it('en la pregunta del abono "no" responde y no cancela; CANCELAR sí cancela', async () => {
      const { start, say, row } = build();
      await start('vendí 1 perfume a Laura, queda debiendo');
      await say('no');
      expect(row().status).toBe('COLLECTING');
      expect(row().payload.depositCOP).toBe(0);
      await say('cancelar');
      expect(row().status).toBe('REJECTED');
    });
  });

  describe('fecha estimada', () => {
    it('se guarda como compromiso de esa venta', async () => {
      const { start, say, row, commitments, sales } = build();
      await start(
        'vendí 1 perfume a Laura, dejó 20 mil por nequi y queda debiendo',
      );
      await say('el 15');
      const reply = await say(`SI ${row().confirmCode}`);
      expect(sales.createSale.mock.calls[0][1]).toMatchObject({
        paymentStatus: 'PENDING',
        deliveryStatus: 'DELIVERED',
        depositCOP: 20_000,
        depositMethod: 'TRANSFER',
        customerId: 'c1',
      });
      expect(commitments.create.mock.calls[0][1].saleIds).toEqual(['s1']);
      expect(commitments.create.mock.calls[0][1].dueOn).toMatch(/-15$/);
      expect(reply).toContain('RS-000123');
      expect(reply).toContain('Paga el');
    });

    it('"sin fecha" registra la venta sin compromiso y lo dice', async () => {
      const { start, say, row, commitments, sales } = build();
      await start('vendí 1 perfume a Laura, queda debiendo');
      await say('no');
      const preview = await say('sin fecha');
      expect(preview).toContain('Fecha de pago: sin fecha');
      await say(`SI ${row().confirmCode}`);
      expect(sales.createSale).toHaveBeenCalledTimes(1);
      expect(commitments.create).not.toHaveBeenCalled();
    });

    it('lo que no es una fecha se vuelve a preguntar', async () => {
      const { start, say, row } = build();
      await start('vendí 1 perfume a Laura, queda debiendo');
      await say('no');
      expect(await say('cuando le paguen')).toContain('¿Para qué fecha');
      expect(row().status).toBe('COLLECTING');
    });

    it('si falla la fecha, la venta queda y se dice', async () => {
      const { start, say, row, commitments, sales } = build();
      commitments.create.mockRejectedValue(
        new BadRequestException('La fecha del compromiso ya pasó'),
      );
      await start('vendí 1 perfume a Laura, queda debiendo, paga el viernes');
      await say('no');
      const reply = await say(`SI ${row().confirmCode}`);
      expect(sales.createSale).toHaveBeenCalledTimes(1);
      expect(row().status).toBe('CONFIRMED');
      expect(reply).toContain('RS-000123');
      expect(reply).toContain('no pude guardar la fecha');
    });
  });

  describe('separado y encargo', () => {
    it('separado: ambos pendientes y no exige opción ni stock', async () => {
      const { start, say, row, sales } = build();
      await start('sepárale a Laura 20 mantequillas');
      await say('no');
      await say('sin fecha');
      expect(row().status).toBe('PENDING');
      await say(`SI ${row().confirmCode}`);
      const dto = sales.createSale.mock.calls[0][1];
      expect(dto).toMatchObject({
        paymentStatus: 'PENDING',
        deliveryStatus: 'PENDING',
      });
      expect(dto.items[0].variantId).toBeUndefined();
    });

    it('encargo pagado: no pregunta fecha de pago', async () => {
      const { start, say, row, sales } = build();
      const preview = (
        await start(
          'encargo de 5 mantequillas de coco para Laura, ya pagó por nequi',
        )
      ).reply;
      expect(preview).toContain('se entrega luego');
      await say(`SI ${row().confirmCode}`);
      expect(sales.createSale.mock.calls[0][1]).toMatchObject({
        paymentStatus: 'PAID',
        deliveryStatus: 'PENDING',
        paymentMethod: 'TRANSFER',
      });
    });

    it('se entrega luego sin cliente: pregunta a nombre de quién', async () => {
      const { start } = build();
      const { reply } = await start(
        'vendí 2 perfumes por nequi, se entrega luego',
      );
      expect(reply).toContain('¿A nombre de quién');
    });
  });

  it('un saludo en medio de una pregunta no es el nombre del cliente', async () => {
    const { start, row } = build();
    const { reply } = await start(
      'vendí 2 perfumes por nequi, se entrega luego',
    );
    expect(reply).toContain('¿A nombre de quién');
    const flow = new RetailSaleFlow(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    expect(flow.applyAnswer(row().payload, 'hola', 'welcome')).toBeNull();
  });

  describe('Lynko no inventa', () => {
    it('un producto que no existe se dice y se pregunta de nuevo', async () => {
      const { start } = build();
      const { reply } = await start('vendí 2 zapatos en efectivo');
      expect(reply).toContain('No encontré "zapatos"');
      expect(reply).toContain('¿Qué vendiste');
    });

    it('una opción que no existe ofrece las reales y no elige', async () => {
      const { start, say, row } = build();
      const { reply } = await start(
        'vendí 1 mantequilla corporal frutos amarillos en efectivo',
      );
      expect(reply).toContain('No tengo');
      expect(reply).toContain('Coco');
      expect(reply).toContain('Frutos rojos');
      await say('2');
      expect(row().payload.lines[0].variantId).toBe('v2');
    });

    it('un producto sin opciones no se inventa una', async () => {
      const { start } = build();
      const { reply } = await start('vendí 1 perfume azul talla 2 en efectivo');
      expect(reply).toContain('no maneja');
    });

    it('con dos productos parecidos pregunta cuál', async () => {
      const other = { ...PERFUME, id: 'p3', name: 'Perfume Rojo' };
      const { start, say, row } = build({
        products: [MANTEQUILLA, PERFUME, other],
      });
      const { reply } = await start('vendí 1 perfume en efectivo');
      expect(reply).toContain('Perfume Azul');
      expect(reply).toContain('Perfume Rojo');
      await say('2');
      expect(row().payload.lines[0].productId).toBe('p3');
    });

    it('con stock insuficiente ofrece solo los tres caminos reales', async () => {
      const { start, say, row } = build();
      const { reply } = await start('vendí 5 mantequillas de coco en efectivo');
      expect(reply).toContain('hay 3 disponibles');
      expect(reply).toContain('Preparar con 3');
      expect(reply).toContain('encargo');
      expect(reply).toContain('Cancelar');
      await say('1');
      expect(row().payload.lines[0].quantity).toBe(3);
      expect(row().status).toBe('PENDING');
    });

    it('elegir encargo exige cliente, porque ahora hay que entregarle', async () => {
      const { start, say, row } = build();
      await start('vendí 5 mantequillas de coco en efectivo');
      expect(await say('2')).toContain('¿A nombre de quién');
      expect(row().payload.delivered).toBe(false);
    });

    it('cancelar desde el stock no registra nada', async () => {
      const { start, say, row, sales } = build();
      await start('vendí 5 mantequillas de coco en efectivo');
      expect(await say('3')).toContain('No se registró nada');
      expect(row().status).toBe('REJECTED');
      expect(sales.createSale).not.toHaveBeenCalled();
    });

    it('suma las líneas del mismo producto y opción', async () => {
      const { start } = build();
      const { reply } = await start(
        'vendí 2 mantequillas de coco y 2 mantequillas de coco en efectivo',
      );
      expect(reply).toContain('hay 3 disponibles y pediste 4');
    });
  });

  describe('cliente', () => {
    it('sin tildes encuentra al que sí las tiene', async () => {
      const { start, row } = build();
      await start('vendí 1 perfume a laura gomez en efectivo');
      expect(row().payload.customerId).toBe('c1');
    });

    it('si no existe, crear es una opción y solo ocurre al confirmar', async () => {
      const { start, say, row, customers, sales } = build({ customers: [] });
      const { reply } = await start('vendí 1 perfume a Pedro en efectivo');
      expect(reply).toContain('No encontré a "Pedro"');
      const preview = await say('1');
      expect(preview).toContain('Cliente nuevo: Pedro');
      expect(customers.createCustomer).not.toHaveBeenCalled();
      await say(`SI ${row().confirmCode}`);
      expect(customers.createCustomer).toHaveBeenCalledTimes(1);
      expect(sales.createSale.mock.calls[0][1].customerId).toBe('c9');
    });

    it('sin permiso de clientes no ofrece crear', async () => {
      const { start } = build({
        customers: [],
        forbid: ['retail:customers:write'],
      });
      const { reply } = await start('vendí 1 perfume a Pedro en efectivo');
      expect(reply).toContain('no puede crear clientes');
      expect(reply).not.toContain('Crear el cliente');
    });

    it('con dos parecidos pregunta cuál', async () => {
      const other = { id: 'c2', name: 'Laura Ruiz', phone: '3009998888' };
      const { start, say, row } = build({ customers: [LAURA, other] });
      const { reply } = await start('vendí 1 perfume a Laura en efectivo');
      expect(reply).toContain('termina en 4567');
      await say('2');
      expect(row().payload.customerId).toBe('c2');
    });
  });

  describe('precio', () => {
    it('sale del catálogo', async () => {
      const { start, row } = build();
      await start('vendí 2 mantequillas de coco en efectivo');
      expect(row().payload.totalCOP).toBe(84_000);
    });

    it('mayorista: el escalón se mide sobre el pedido completo', async () => {
      const { start, row } = build({
        products: [
          {
            ...MANTEQUILLA,
            stockOptionId: null,
            stockOptionIds: [],
            variants: [],
            availableStock: 20,
          },
        ],
      });
      await start('vendí 6 mantequillas al por mayor en efectivo');
      expect(row().payload.lines[0].unitPriceCOP).toBe(30_000);
    });

    it('un precio por debajo del mínimo no pasa', async () => {
      const { start } = build();
      const { reply } = await start(
        'vendí 1 mantequilla de coco a 20 mil en efectivo',
      );
      expect(reply).toContain('precio mínimo');
    });

    it('respeta el precio dicho si está permitido', async () => {
      const { start, row } = build();
      await start('vendí 1 mantequilla de coco a 40 mil en efectivo');
      expect(row().payload.lines[0].unitPriceCOP).toBe(40_000);
    });

    it('un abono que cubre el total se aclara, no se corrige en silencio', async () => {
      const { start, say, row } = build();
      const { reply } = await start(
        'vendí 1 perfume a Laura, dejó 200 mil por nequi y queda debiendo',
      );
      expect(reply).toContain('cubre el total');
      await say('1');
      expect(row().payload.paid).toBe(true);
    });
  });

  describe('lo que va al mostrador', () => {
    it.each([
      ['vendí 1 perfume financiado con addi', 'financiada'],
      ['vendí 1 perfume, mitad en efectivo y mitad por nequi', 'repartido'],
    ])('"%s"', async (message, word) => {
      const { start, row, sales } = build();
      const { reply } = await start(message);
      expect(reply).toContain(word);
      expect(row().status).toBe('REJECTED');
      expect(sales.createSale).not.toHaveBeenCalled();
    });
  });

  describe('permisos y confirmación', () => {
    it('sin permiso de ventas no arranca', async () => {
      const { start } = build({ forbid: ['retail:sales:write'] });
      expect((await start('vendí 1 perfume')).reply).toContain(
        'no tiene permiso',
      );
    });

    it('un negocio que no es tienda no registra ventas', async () => {
      const { start, row } = build({ vertical: 'barber' });
      expect((await start('vendí 1 perfume')).reply).toContain(
        'no registra ventas',
      );
      expect(row()).toBeUndefined();
    });

    it('la venta queda marcada con el canal y el borrador de donde salió', async () => {
      const { start, say, row, sales } = build();
      await start('vendí 1 perfume en efectivo');
      await say(`SI ${row().confirmCode}`);
      expect(sales.createSale.mock.calls[0][2]).toEqual({
        channel: AssistantChannel.WHATSAPP,
        proposalId: row().id,
      });
    });

    it('el código no se reutiliza ni crea dos ventas', async () => {
      const { start, say, row, sales } = build();
      await start('vendí 1 perfume en efectivo');
      const code = row().confirmCode;
      await say(`SI ${code}`);
      expect(await say(`SI ${code}`)).toContain('ya se registró');
      expect(sales.createSale).toHaveBeenCalledTimes(1);
    });

    it('si el backend rechaza al confirmar, se muestra su mensaje', async () => {
      const { start, say, row, sales } = build();
      sales.createSale.mockRejectedValue(
        new BadRequestException(
          'Stock insuficiente de "Perfume Azul": hay 0, se piden 1',
        ),
      );
      await start('vendí 1 perfume en efectivo');
      const reply = await say(`SI ${row().confirmCode}`);
      expect(reply).toContain('Stock insuficiente');
      expect(row().status).toBe('FAILED');
    });

    it('venta de ayer: la fecha viaja y se muestra', async () => {
      const { start, say, row, sales } = build();
      const { reply } = await start('vendí 1 perfume ayer en efectivo');
      expect(reply).toContain('Fecha de la venta');
      await say(`SI ${row().confirmCode}`);
      expect(sales.createSale.mock.calls[0][1].soldAt).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    });
  });
});
