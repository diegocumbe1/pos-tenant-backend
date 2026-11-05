/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { AssistantChannel } from '@prisma/client';
import { ExpenseFlow } from './expense.flow';
import {
  AgentProposalsService,
  ProposalScope,
} from './agent-proposals.service';

/** Lo que importa es el criterio: nada se registra sin el código correcto. */

const actor = (id = 'u1') => ({
  id,
  email: `${id}@x.co`,
  name: 'Paola',
  tenantId: 't1',
  roleId: 'r1',
  roleCode: 'OWNER',
  isRoot: false,
  isPlatformAdmin: false,
  passwordSetAt: new Date(),
  accessibleBranches: ['b1'],
});
const SCOPE: ProposalScope = {
  business: { id: 't1', name: 'Bella Chic', vertical: { code: 'retail' } },
  actor: actor(),
};
const WHO = {
  channel: AssistantChannel.WHATSAPP,
  externalUserId: '573001234567',
};

function build(
  options: {
    accounts?: unknown[];
    branches?: unknown[];
    allowed?: boolean;
  } = {},
) {
  const rows: Record<string, any>[] = [];
  const matches = (row: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && 'gt' in value) {
        return row[key] > (value as { gt: Date }).gt;
      }
      return row[key] === value;
    });
  const latestFirst = () => [...rows].reverse();
  const agentProposal = {
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
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      const found = rows.filter((r) => matches(r, where));
      found.forEach((r) => Object.assign(r, data));
      return { count: found.length };
    }),
    findFirst: jest.fn(
      async ({ where }) => latestFirst().find((r) => matches(r, where)) ?? null,
    ),
    findMany: jest.fn(async ({ where }) =>
      rows.filter((r) => matches(r, where)),
    ),
  };
  const prisma = {
    agentProposal,
    branch: {
      findMany: jest
        .fn()
        .mockResolvedValue(options.branches ?? [{ id: 'b1', name: 'Centro' }]),
    },
    moneyAccount: {
      findMany: jest.fn().mockResolvedValue(options.accounts ?? []),
    },
  };
  const scope = {
    contextFor: jest.fn().mockResolvedValue({ tenantId: 't1', branchId: 'b1' }),
    assertPermission: jest.fn(() => {
      if (options.allowed === false) throw new ForbiddenException();
    }),
  };
  const finance = {
    createExpense: jest.fn().mockResolvedValue({ id: 'exp1' }),
  };
  const settings = {
    get: jest.fn().mockResolvedValue({ agentCaptureEnabled: true }),
  };
  const quota = { assertAvailable: jest.fn().mockResolvedValue(undefined) };
  const service = new AgentProposalsService(
    prisma as never,
    scope as never,
    settings as never,
    quota as never,
    new ExpenseFlow(prisma as never, scope as never, finance as never),
    { kind: 'retail_sale' } as never,
  );
  const say = (message: string, scopes = [SCOPE]) =>
    service.handle({ ...WHO, message, intent: 'unknown', scopes });
  const start = (message: string, s = SCOPE) =>
    service.start('expense', { ...WHO, message }, s);
  /** Borrador completo, listo para confirmar. Devuelve su código. */
  const draft = async () => {
    await start('gasté 50 mil en domicilios');
    await say('1');
    return rows[rows.length - 1].confirmCode as string;
  };
  return { service, rows, finance, scope, settings, quota, say, start, draft };
}

describe('AgentProposalsService', () => {
  describe('interruptor', () => {
    it('solo funciona por WhatsApp: la voz de Alexa nunca entra', async () => {
      const { service } = build();
      expect(await service.enabled(AssistantChannel.ALEXA)).toBe(false);
      expect(await service.enabled(AssistantChannel.WHATSAPP)).toBe(true);
    });

    it('si no se puede leer, queda apagado', async () => {
      const { service, settings } = build();
      settings.get.mockRejectedValue(new Error('db down'));
      expect(await service.enabled(AssistantChannel.WHATSAPP)).toBe(false);
    });
  });

  describe('preguntar lo que falta', () => {
    it('pregunta una cosa a la vez y no registra nada', async () => {
      const { start, say, finance } = build();
      expect((await start('registrar gasto')).reply).toContain('¿De cuánto');
      expect((await say('50 mil'))!.reply).toContain('¿En qué fue');
      expect((await say('Domicilios'))!.reply).toContain('categoría');
      const preview = await say('1');
      expect(preview!.reply).toContain('Código de este borrador');
      expect(finance.createExpense).not.toHaveBeenCalled();
    });

    it('un "50" a secas se aclara antes de seguir', async () => {
      const { start, say, rows } = build();
      expect((await start('gasté 50 en domicilios')).reply).toContain('$');
      await say('2');
      expect(rows[0].payload.amountCOP).toBe(50_000);
    });

    it('ofrece las cuentas reales y no elige si no se dijo', async () => {
      const accounts = [
        { id: 'a1', name: 'Caja', type: 'CASH', defaultForMethods: ['CASH'] },
      ];
      const { draft, say, rows } = build({ accounts });
      await draft();
      expect(rows[0].status).toBe('COLLECTING');
      const preview = await say('Caja');
      expect(preview!.reply).toContain('Sale de: Caja');
    });

    it('usa la cuenta que se nombró', async () => {
      const accounts = [
        { id: 'a1', name: 'Caja', type: 'CASH', defaultForMethods: ['CASH'] },
      ];
      const { start, say, rows } = build({ accounts });
      await start('gasté 50 mil en domicilios de efectivo');
      await say('1');
      expect(rows[0].payload.moneyAccountId).toBe('a1');
    });

    it('con varias sedes pregunta y guarda la elegida', async () => {
      const branches = [
        { id: 'b1', name: 'Centro' },
        { id: 'b2', name: 'Norte' },
      ];
      const { draft, say, rows } = build({ branches });
      await draft();
      await say('Norte');
      expect(rows[0].branchId).toBe('b2');
      expect(rows[0].status).toBe('PENDING');
    });

    it('otra pregunta se contesta y el borrador sigue abierto', async () => {
      const { start, service, rows } = build();
      await start('registrar gasto');
      const reply = await service.handle({
        ...WHO,
        message: 'cuánto vendí hoy',
        intent: 'sales_summary',
        scopes: [SCOPE],
      });
      expect(reply).toBeNull();
      expect(rows[0].status).toBe('COLLECTING');
    });

    it('un "domicilio" es la respuesta aunque parezca otra consulta', async () => {
      const { start, service, rows } = build();
      await start('gasté 50 mil');
      await service.handle({
        ...WHO,
        message: 'domicilio',
        intent: 'pending_delivery',
        scopes: [SCOPE],
      });
      expect(rows[0].payload.concept).toBe('Domicilio');
    });

    it('un NO lo deja sin registrar', async () => {
      const { start, say, rows } = build();
      await start('registrar gasto');
      expect((await say('no'))!.reply).toContain('No se registró');
      expect(rows[0].status).toBe('REJECTED');
    });

    it('sin permiso de escritura no arranca', async () => {
      const { start, rows } = build({ allowed: false });
      expect((await start('gasté 50 mil')).reply).toContain('no tiene permiso');
      expect(rows).toHaveLength(0);
    });

    it('una cuenta de plataforma no escribe en los negocios', async () => {
      const { start, rows } = build();
      const reply = await start('gasté 50 mil', {
        ...SCOPE,
        actor: { ...actor(), isPlatformAdmin: true },
      });
      expect(reply.reply).toContain('plataforma');
      expect(rows).toHaveLength(0);
    });
  });

  describe('el código', () => {
    it('el borrador dice a qué corresponde', async () => {
      const { draft, rows } = build();
      const code = await draft();
      expect(code).toMatch(/^\d{4}$/);
      expect(rows[0].preview).toContain(`Solo sirve para este gasto de`);
      expect(rows[0].preview).toContain('(Domicilios)');
      expect(rows[0].preview).toContain(`SI ${code}`);
      expect(rows[0].preview).toContain(`NO ${code}`);
    });

    it('confirma con el servicio de siempre y nombra lo registrado', async () => {
      const { draft, say, finance, rows } = build();
      const code = await draft();
      const reply = await say(`SI ${code}`);
      expect(finance.createExpense).toHaveBeenCalledTimes(1);
      expect(finance.createExpense.mock.calls[0][1]).toMatchObject({
        category: 'OPERATIONS',
        concept: 'Domicilios',
        amountCOP: 50_000,
      });
      expect(finance.createExpense.mock.calls[0][2]).toEqual({
        channel: AssistantChannel.WHATSAPP,
        proposalId: rows[0].id,
      });
      expect(reply!.reply).toContain(`del borrador ${code}`);
      expect(reply!.level).toBe('EXECUTE');
      expect(rows[0]).toMatchObject({ status: 'CONFIRMED', resultRef: 'exp1' });
    });

    it('repetir el código no crea otro registro', async () => {
      const { draft, say, finance } = build();
      const code = await draft();
      await say(`SI ${code}`);
      const again = await say(`SI ${code}`);
      expect(finance.createExpense).toHaveBeenCalledTimes(1);
      expect(again!.reply).toContain('ya se registró');
    });

    it('dos confirmaciones simultáneas ejecutan una sola', async () => {
      const { draft, say, finance } = build();
      const code = await draft();
      await Promise.all([say(`SI ${code}`), say(`SI ${code}`)]);
      expect(finance.createExpense).toHaveBeenCalledTimes(1);
    });

    it('un "sí" sin código no ejecuta y recuerda cuál es', async () => {
      const { draft, say, finance } = build();
      const code = await draft();
      const reply = await say('sí');
      expect(finance.createExpense).not.toHaveBeenCalled();
      expect(reply!.reply).toContain(`SI ${code}`);
    });

    it('un código que no existe no ejecuta nada', async () => {
      const { draft, say, finance } = build();
      const code = await draft();
      const other = code === '1234' ? '4321' : '1234';
      const reply = await say(`SI ${other}`);
      expect(finance.createExpense).not.toHaveBeenCalled();
      expect(reply!.reply).toContain(
        `No tengo un borrador con el código ${other}`,
      );
      expect(reply!.reply).toContain(code);
    });

    it('un borrador vencido no se registra', async () => {
      const { draft, say, finance, rows } = build();
      const code = await draft();
      rows[0].expiresAt = new Date(Date.now() - 1000);
      const reply = await say(`SI ${code}`);
      expect(finance.createExpense).not.toHaveBeenCalled();
      expect(reply!.reply).toContain('venció');
      expect(rows[0].status).toBe('EXPIRED');
    });

    it('otra cuenta no puede aprobarlo', async () => {
      const { draft, say, finance } = build();
      const code = await draft();
      const reply = await say(`SI ${code}`, [{ ...SCOPE, actor: actor('u2') }]);
      expect(finance.createExpense).not.toHaveBeenCalled();
      expect(reply!.reply).toContain('No se registró nada');
    });

    it('si le quitaron el permiso después, no se registra', async () => {
      const { draft, say, finance, scope } = build();
      const code = await draft();
      scope.assertPermission.mockImplementation(() => {
        throw new ForbiddenException();
      });
      const reply = await say(`SI ${code}`);
      expect(finance.createExpense).not.toHaveBeenCalled();
      expect(reply!.reply).toContain('no tiene permiso');
    });

    it('un rechazo del servicio se dice tal cual y no se reintenta', async () => {
      const { draft, say, finance, rows } = build();
      const code = await draft();
      finance.createExpense.mockRejectedValue(
        new BadRequestException('Esa cuenta no existe'),
      );
      const reply = await say(`SI ${code}`);
      expect(reply!.reply).toContain('Esa cuenta no existe');
      expect(reply!.reply).toContain(code);
      expect(rows[0].status).toBe('FAILED');
    });

    it('NO con el código lo cancela y ya no se puede confirmar', async () => {
      const { draft, say, finance } = build();
      const code = await draft();
      expect((await say(`NO ${code}`))!.reply).toContain(
        `Cancelé el borrador ${code}`,
      );
      expect((await say(`SI ${code}`))!.reply).toContain('ya estaba cancelado');
      expect(finance.createExpense).not.toHaveBeenCalled();
    });

    it('"¿qué es 4821?" muestra el borrador sin ejecutar', async () => {
      const { draft, say, finance } = build();
      const code = await draft();
      const reply = await say(`¿qué es ${code}?`);
      expect(reply!.reply).toContain('Lynko armó este gasto');
      expect(finance.createExpense).not.toHaveBeenCalled();
    });

    it('con varios abiertos cada uno tiene su código y "sí" los lista', async () => {
      const { draft, say, finance, rows } = build();
      const first = await draft();
      const second = await draft();
      expect(rows[1].confirmCode).not.toBe(first);
      const reply = await say('sí');
      expect(reply!.reply).toContain(first);
      expect(reply!.reply).toContain(second);
      expect(finance.createExpense).not.toHaveBeenCalled();
      expect((await say('pendientes'))!.reply).toContain(second);
    });

    it('el negocio se valida contra los del actor, no contra lo guardado', async () => {
      const { draft, say, finance } = build();
      const code = await draft();
      const reply = await say(`SI ${code}`, []);
      expect(finance.createExpense).not.toHaveBeenCalled();
      expect(reply!.reply).toContain('No se registró nada');
    });
  });
});
