import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Response } from 'express';
import { GoogleCalendarService } from './google-calendar.service';

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
}

/** Página mínima para quien conectó desde el enlace y no tiene Lynko abierto. */
function page(title: string, body: string, ok: boolean): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e2e8f0;font:16px/1.5 system-ui,sans-serif;padding:16px}
main{max-width:420px;text-align:center}h1{font-size:20px;color:${ok ? '#6ee7b7' : '#fca5a5'}}p{color:#94a3b8}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${body}</p></main></body></html>`;
}

/**
 * Las dos rutas sin sesión de Google Calendar: el enlace que abre el
 * especialista y la vuelta de Google. La autorización viaja firmada en el
 * `state`; sin firma válida no se conecta nada.
 */
@ApiExcludeController()
@Controller('public/google-calendar')
export class GoogleCalendarPublicController {
  private readonly logger = new Logger(GoogleCalendarPublicController.name);

  constructor(private readonly calendar: GoogleCalendarService) {}

  @Get('connect')
  connect(@Query('token') token: string, @Res() res: Response) {
    const url = token ? this.calendar.authUrlFromLink(token) : null;
    if (!url) {
      return res
        .status(400)
        .send(
          page(
            'El enlace venció',
            'Pídele al negocio que te mande uno nuevo desde Lynko.',
            false,
          ),
        );
    }
    return res.redirect(url);
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    if (error || !code || !state) {
      return res
        .status(400)
        .send(
          page(
            'No se conectó',
            'Se canceló el permiso en Google. Puedes volver a abrir el enlace cuando quieras.',
            false,
          ),
        );
    }
    try {
      const result = await this.calendar.handleCallback(code, state);
      if (result.state.returnTo === 'settings') {
        const base = (
          process.env.PUBLIC_APP_URL || 'https://uselynko.com'
        ).replace(/\/+$/, '');
        return res.redirect(
          `${base}/barber/settings?tab=integrations&gcal=connected`,
        );
      }
      return res.send(
        page(
          'Listo, quedó conectado',
          `Tus citas de <b>${escapeHtml(result.businessName)}</b> van a aparecer en el calendario <b>Lynko · ${escapeHtml(result.businessName)}</b> de tu Google Calendar, con aviso antes de cada una. Ya puedes cerrar esta página.`,
          true,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Callback de Google Calendar falló: ${message}`);
      return res
        .status(400)
        .send(page('No se pudo conectar', escapeHtml(message), false));
    }
  }
}
