import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SkillRequestSignatureVerifier,
  TimestampVerifier,
} from 'ask-sdk-express-adapter';
import { AlexaService } from './alexa.service';

describe('AlexaService', () => {
  let service: AlexaService;
  let signature: jest.SpyInstance;
  const skillId = 'test-skill';
  const envelope = (type = 'LaunchRequest', name?: string) => ({
    version: '1.0',
    context: { System: { application: { applicationId: skillId } } },
    request: {
      type,
      timestamp: new Date().toISOString(),
      ...(name && { intent: { name } }),
    },
  });
  const send = (body: unknown) =>
    service.handleRequest(Buffer.from(JSON.stringify(body)), {});

  beforeEach(() => {
    service = new AlexaService(new ConfigService({ ALEXA_SKILL_ID: skillId }));
    signature = jest
      .spyOn(SkillRequestSignatureVerifier.prototype, 'verify')
      .mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    [
      'LaunchRequest',
      undefined,
      'Hola. Lynko está conectado correctamente. Puedes preguntarme por tus suscripciones.',
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
      'Puedes preguntarme cuántas suscripciones tienes.',
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
    service = new AlexaService(new ConfigService({ ALEXA_SKILL_ID: '' }));
    await expect(send(envelope())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
