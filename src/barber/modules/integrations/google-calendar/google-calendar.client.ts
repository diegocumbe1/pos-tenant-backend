/**
 * Las llamadas a Google, con `fetch` y sin SDK: son pocas y así no se trae
 * `googleapis` (decenas de MB) para cinco endpoints.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT_MS = 15_000;

// `calendar.app.created`: crear calendarios propios y escribir solo en ellos.
// `calendar.freebusy`: ver ocupado/libre, sin títulos. Ninguno lee los eventos
// personales. Configurable por si Google cambia los nombres.
const DEFAULT_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/calendar.freebusy',
];

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** `invalid_grant` = el token ya no sirve: hay que volver a conectar. */
    readonly reason?: string,
  ) {
    super(message);
  }
}

export function googleConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_CALENDAR_REDIRECT_URI &&
    process.env.GOOGLE_TOKEN_ENC_KEY,
  );
}

function scopes(): string {
  return process.env.GOOGLE_CALENDAR_SCOPES?.trim() || DEFAULT_SCOPES.join(' ');
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: process.env.GOOGLE_CALENDAR_REDIRECT_URI!,
    response_type: 'code',
    scope: scopes(),
    // offline + consent: sin esto Google no entrega refresh token la segunda vez.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function call<T>(
  url: string,
  init: RequestInit & { accessToken?: string } = {},
): Promise<T> {
  const { accessToken, headers, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(rest.body && typeof rest.body === 'string'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const error = json.error;
    const reason =
      typeof error === 'string'
        ? error
        : ((error as { errors?: { reason?: string }[] })?.errors?.[0]?.reason ??
          undefined);
    const message =
      (json.error_description as string) ??
      (error as { message?: string })?.message ??
      `Google respondió ${res.status}`;
    throw new GoogleApiError(message, res.status, reason);
  }
  return json as T;
}

function tokenRequest(params: Record<string, string>) {
  return call<{
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    id_token?: string;
  }>(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      ...params,
    }),
  });
}

export async function exchangeCode(code: string) {
  const res = await tokenRequest({
    code,
    grant_type: 'authorization_code',
    redirect_uri: process.env.GOOGLE_CALENDAR_REDIRECT_URI!,
  });
  if (!res.refresh_token) {
    throw new GoogleApiError('Google no entregó el permiso permanente', 400);
  }
  // El id_token llega directo del endpoint de tokens por TLS: se puede leer
  // sin verificar la firma (OpenID Connect, 3.1.3.7).
  const payload = res.id_token
    ? (JSON.parse(
        Buffer.from(res.id_token.split('.')[1], 'base64url').toString('utf8'),
      ) as { email?: string })
    : {};
  return {
    refreshToken: res.refresh_token,
    accessToken: res.access_token,
    expiresIn: res.expires_in,
    email: payload.email ?? '',
  };
}

export async function refreshAccessToken(refreshToken: string) {
  const res = await tokenRequest({
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return { accessToken: res.access_token, expiresIn: res.expires_in };
}

export async function revokeToken(token: string): Promise<void> {
  await call(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

export async function createCalendar(
  accessToken: string,
  summary: string,
): Promise<string> {
  const res = await call<{ id: string }>(`${API}/calendars`, {
    method: 'POST',
    accessToken,
    body: JSON.stringify({ summary, timeZone: 'America/Bogota' }),
  });
  return res.id;
}

export async function deleteCalendar(
  accessToken: string,
  calendarId: string,
): Promise<void> {
  await call(`${API}/calendars/${encodeURIComponent(calendarId)}`, {
    method: 'DELETE',
    accessToken,
  });
}

export type GoogleEventBody = {
  summary: string;
  description: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  reminders: {
    useDefault: false;
    overrides: { method: 'popup'; minutes: number }[];
  };
  extendedProperties: { private: Record<string, string> };
};

/**
 * Crea el evento con el id que se le da, o lo reescribe si ya existe. Con id
 * propio un reintento no duplica, y un evento borrado se revive con el PUT.
 */
export async function putEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  body: GoogleEventBody,
): Promise<void> {
  const base = `${API}/calendars/${encodeURIComponent(calendarId)}/events`;
  try {
    await call(`${base}?sendUpdates=none`, {
      method: 'POST',
      accessToken,
      body: JSON.stringify({ id: eventId, ...body }),
    });
  } catch (err) {
    if (!(err instanceof GoogleApiError) || err.status !== 409) throw err;
    await call(`${base}/${eventId}?sendUpdates=none`, {
      method: 'PUT',
      accessToken,
      body: JSON.stringify({ ...body, status: 'confirmed' }),
    });
  }
}

export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  try {
    await call(
      `${API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=none`,
      { method: 'DELETE', accessToken },
    );
  } catch (err) {
    // Ya no estaba: alguien lo borró a mano. Es lo que se quería.
    if (err instanceof GoogleApiError && [404, 410].includes(err.status)) {
      return;
    }
    throw err;
  }
}

/** Rangos ocupados del calendario principal de la persona. */
export async function queryFreeBusy(
  accessToken: string,
  from: Date,
  to: Date,
): Promise<{ start: Date; end: Date }[]> {
  const res = await call<{
    calendars: Record<string, { busy?: { start: string; end: string }[] }>;
  }>(`${API}/freeBusy`, {
    method: 'POST',
    accessToken,
    body: JSON.stringify({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      items: [{ id: 'primary' }],
    }),
  });
  return (res.calendars.primary?.busy ?? []).map((b) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));
}
