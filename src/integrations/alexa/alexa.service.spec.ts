import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SkillRequestSignatureVerifier,
  TimestampVerifier,
} from 'ask-sdk-express-adapter';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { AlexaAuthService } from './alexa-auth.service';
import { AlexaService } from './alexa.service';

const ASK_FOR_CODE =
  'Para consultar tus negocios necesito tu código de activación. Di: mi código es, y tu frase.';

describe('AlexaService', () => {
  let service: AlexaService;
  let auth: {
    actor: jest.Mock;
    activate: jest.Mock;
    logout: jest.Mock;
  };
  let signature: jest.SpyInstance;
  const skillId = 'test-skill';
  const actor = { id: 'user-1', name: 'Diego Cumbe' } as AuthenticatedUser;
  const envelope = (
    type = 'LaunchRequest',
    name?: string,
    slots?: Record<string, { name: string; value: string }>,
  ) => ({
    version: '1.0',
    context: { System: { application: { applicationId: skillId } } },
    request: {
      type,
      timestamp: new Date().toISOString(),
      ...(name && { intent: { name, ...(slots && { slots }) } }),
    },
  });
  const send = (body: unknown) =>
    service.handleRequest(Buffer.from(JSON.stringify(body)), {});
  const activation = (value: string) =>
    send(
      envelope('IntentRequest', 'ActivarLynkoIntent', {
        codigo: { name: 'codigo', value },
      }),
    );
  const build = (env: Record<string, string> = {}) => {
    service = new AlexaService(
      new ConfigService({
        ALEXA_SKILL_ID: skillId,
        ALEXA_AUTH_TTL_DAYS: '7',
        ...env,
      }),
      auth as unknown as AlexaAuthService,
    );
  };

  beforeEach(() => {
    auth = {
      actor: jest.fn().mockResolvedValue(actor),
      activate: jest.fn().mockResolvedValue('active'),
      logout: jest.fn().mockResolvedValue(undefined),
    };
    build();
    signature = jest
      .spyOn(SkillRequestSignatureVerifier.prototype, 'verify')
      .mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [
      'LaunchRequest',
      undefined,
      'Hola Diego. Lynko está listo. Puedes preguntarme por tus suscripciones.',
      false,
    ],
    [
      'IntentRequest',
      'GetSubscriptionsIntent',
      'Perfecto. Lynko recibió correctamente tu consulta de suscripciones.',
      true,
    ],
    [
      'IntentRequest',
      'AMAZON.HelpIntent',
      'Puedes preguntarme cuántas suscripciones tienes. Para activar el acceso di: mi código es, y tu frase. Para revocarlo di: cierra mi acceso.',
      false,
    ],
    ['IntentRequest', 'AMAZON.StopIntent', 'Hasta luego.', true],
    ['IntentRequest', 'AMAZON.CancelIntent', 'Hasta luego.', true],
    [
      'IntentRequest',
      'UnknownIntent',
      'No pude reconocer esa consulta. Por ahora puedes preguntarme por tus suscripciones.',
      false,
    ],
  ])('handles %s %s', async (type, name, text, shouldEndSession) => {
    const result = await send(envelope(type, name));
    expect(result).toMatchObject({
      version: '1.0',
      response: { outputSpeech: { type: 'PlainText', text }, shouldEndSession },
    });
    expect(Boolean(result.response.reprompt)).toBe(!shouldEndSession);
  });

  describe('voice authorization', () => {
    const speech = (result: { response: { outputSpeech?: unknown } }) =>
      (result.response.outputSpeech as { text: string }).text;

    it.each(['LaunchRequest', 'IntentRequest'])(
      'asks for the activation code on %s when the grant expired',
      async (type) => {
        auth.actor.mockResolvedValue(null);
        const result = await send(envelope(type, 'GetSubscriptionsIntent'));
        expect(speech(result)).toBe(ASK_FOR_CODE);
        expect(result.response.shouldEndSession).toBe(false);
      },
    );

    it.each([
      [
        new ForbiddenException(),
        'Esta cuenta de Alexa no está autorizada para usar Lynko.',
      ],
      [
        new ServiceUnavailableException(),
        'La autorización por voz de Lynko todavía no está configurada.',
      ],
    ])(
      'rejects with a spoken reason instead of an error',
      async (error, text) => {
        auth.actor.mockRejectedValue(error);
        const result = await send(envelope());
        expect(speech(result)).toBe(text);
        expect(result.response.shouldEndSession).toBe(true);
      },
    );

    it('grants access for the configured window', async () => {
      const result = await activation('mi frase secreta larga');
      expect(auth.activate).toHaveBeenCalledWith(
        expect.objectContaining({ version: '1.0' }),
        'mi frase secreta larga',
      );
      expect(speech(result)).toBe(
        'Listo. Tu acceso a Lynko queda activo 7 días. Puedes preguntarme por tus suscripciones.',
      );
      expect(result.response.shouldEndSession).toBe(false);
    });

    it('keeps the session open after a wrong code', async () => {
      auth.activate.mockResolvedValue('invalid');
      const result = await activation('frase equivocada aqui');
      expect(speech(result)).toBe(
        'Ese código no coincide. Inténtalo otra vez.',
      );
      expect(result.response.shouldEndSession).toBe(false);
    });

    it('ends the session once attempts are exhausted', async () => {
      auth.activate.mockResolvedValue('locked');
      const result = await activation('frase equivocada aqui');
      expect(speech(result)).toBe(
        'Demasiados intentos fallidos. Espera quince minutos antes de volver a intentarlo.',
      );
      expect(result.response.shouldEndSession).toBe(true);
    });

    it('never calls activate without a spoken phrase', async () => {
      const result = await send(
        envelope('IntentRequest', 'ActivarLynkoIntent'),
      );
      expect(auth.activate).not.toHaveBeenCalled();
      expect(speech(result)).toBe(ASK_FOR_CODE);
    });

    it('revokes access on request', async () => {
      const result = await send(
        envelope('IntentRequest', 'CerrarAccesoIntent'),
      );
      expect(auth.logout).toHaveBeenCalled();
      expect(speech(result)).toBe('Listo. Cerré tu acceso a Lynko.');
      expect(result.response.shouldEndSession).toBe(true);
    });

    it('does not reach services before the grant is checked', async () => {
      auth.actor.mockResolvedValue(null);
      await send(envelope('IntentRequest', 'GetSubscriptionsIntent'));
      expect(auth.actor).toHaveBeenCalledTimes(1);
    });
  });

  it('ends a session without speech', async () => {
    expect(await send(envelope('SessionEndedRequest'))).toEqual({
      version: '1.0',
      response: {},
    });
  });
  it('verifies the exact original bytes and headers', async () => {
    const raw = JSON.stringify(envelope(), null, 2);
    const headers = { 'signature-256': 'test-signature' };
    const timestamp = jest.spyOn(TimestampVerifier.prototype, 'verify');
    await service.handleRequest(Buffer.from(raw), headers);
    expect(signature).toHaveBeenCalledWith(raw, headers);
    expect(timestamp).toHaveBeenCalledWith(raw);
  });
  it('rejects invalid signatures', async () => {
    signature.mockRejectedValue(new Error('Invalid signature'));
    await expect(send(envelope())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
  it('rejects unsigned requests using the real verifier', async () => {
    signature.mockRestore();
    await expect(send(envelope())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
  it.each([
    'invalid',
    new Date(Date.now() - 200000).toISOString(),
    new Date(Date.now() + 200000).toISOString(),
  ])('rejects timestamp %s', async (timestamp) => {
    const body = envelope();
    body.request.timestamp = timestamp;
    await expect(send(body)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('rejects a different skill', async () => {
    const body = envelope();
    body.context.System.application.applicationId = 'other-skill';
    await expect(send(body)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('accepts the application ID in session alone', async () => {
    const { context, ...body } = envelope();
    expect(
      await send({
        ...body,
        session: { application: context.System.application },
      }),
    ).toHaveProperty('version', '1.0');
  });
  it('rejects conflicting application IDs', async () => {
    await expect(
      send({
        ...envelope(),
        session: { application: { applicationId: 'other-skill' } },
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('rejects missing application IDs', async () => {
    const body = { ...envelope(), context: {} };
    await expect(send(body)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it.each([undefined, Buffer.from('invalid json'), Buffer.from('{}')])(
    'rejects absent or malformed body',
    async (body) => {
      await expect(service.handleRequest(body, {})).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );
  it('fails closed when not configured', async () => {
    build({ ALEXA_SKILL_ID: '' });
    await expect(send(envelope())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
