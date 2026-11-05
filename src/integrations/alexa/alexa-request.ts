import { Logger, UnauthorizedException } from '@nestjs/common';
import {
  SkillRequestSignatureVerifier,
  TimestampVerifier,
} from 'ask-sdk-express-adapter';
import { IntentRequest, RequestEnvelope } from 'ask-sdk-model';
import { IncomingHttpHeaders } from 'http';

const signatureVerifier = new SkillRequestSignatureVerifier();
const timestampVerifier = new TimestampVerifier();

/** Firma, vigencia y forma de la petición. Vale para todas las rutas de Alexa. */
export async function verifyAlexaRequest(
  rawBody: Buffer | undefined,
  headers: IncomingHttpHeaders,
  logger: Logger,
): Promise<RequestEnvelope> {
  try {
    if (!rawBody?.length) throw new Error('Missing raw body');
    const body = rawBody.toString('utf8');
    const envelope = JSON.parse(body) as RequestEnvelope;
    // The SDK rejects stale requests; explicitly reject invalid/future dates too.
    const timestamp = envelope?.request?.timestamp;
    if (
      typeof timestamp !== 'string' ||
      !Number.isFinite(Date.parse(timestamp)) ||
      Math.abs(Date.now() - Date.parse(timestamp)) > 150_000
    ) {
      throw new Error('Invalid timestamp');
    }
    await timestampVerifier.verify(body);
    await signatureVerifier.verify(body, headers);

    const sessionId = envelope.session?.application?.applicationId;
    const contextId = envelope.context?.System?.application?.applicationId;
    if (
      (!sessionId && !contextId) ||
      // Las dos copias del id tienen que coincidir entre sí: una petición que
      // diga una skill en la sesión y otra en el contexto está manipulada.
      (sessionId !== undefined &&
        contextId !== undefined &&
        sessionId !== contextId) ||
      envelope.version !== '1.0' ||
      typeof envelope.request?.type !== 'string' ||
      (envelope.request.type === 'IntentRequest' &&
        typeof envelope.request.intent?.name !== 'string')
    ) {
      throw new Error('Invalid envelope');
    }
    return envelope;
  } catch {
    logger.warn('Request verification failed');
    throw new UnauthorizedException('Invalid Alexa request');
  }
}

export function applicationIdOf(envelope: RequestEnvelope): string {
  return (
    envelope.context?.System?.application?.applicationId ??
    envelope.session?.application?.applicationId ??
    ''
  );
}

/**
 * Valor del slot, prefiriendo el canónico sobre lo que se oyó.
 *
 * Cuando el slot es de tipo propio y Alexa acierta un sinónimo, deja el valor
 * de la lista en `resolutions`. Usar `slot.value` a secas desperdicia esos
 * sinónimos: el Echo transcribe "Bella Chic" como "bellachi", y solo el
 * canónico dice que eso era Bella Chic.
 */
export function slotValueOf(
  request: IntentRequest,
  name: string,
): string | undefined {
  const slot = request.intent.slots?.[name];
  if (!slot) return undefined;
  const matched = slot.resolutions?.resolutionsPerAuthority?.find(
    (authority) => authority.status.code === 'ER_SUCCESS_MATCH',
  );
  return matched?.values?.[0]?.value?.name ?? slot.value;
}
