import { Injectable } from '@nestjs/common';
import { escapeHtml } from './payment-methods.service';

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

export interface RenderResult {
  text: string;
  /** Variables que la plantilla pide y quedaron vacías. */
  missing: string[];
}

/**
 * Reemplazo de `{{variable}}` contra un mapa de valores. Puro y sin estado: es
 * la pieza que se puede probar sin base de datos ni canales.
 */
@Injectable()
export class TemplateRendererService {
  /** Render de texto plano (WhatsApp, y fallback del correo). */
  render(template: string, values: Record<string, string>): RenderResult {
    const missing = new Set<string>();
    const text = template.replace(PLACEHOLDER, (_match, key: string) => {
      const value = values[key];
      if (value === undefined || value === '') {
        missing.add(key);
        return '';
      }
      return value;
    });
    return { text: this.tidy(text), missing: [...missing] };
  }

  /**
   * Render de correo. Algunas variables tienen versión HTML propia (el bloque de
   * medios de pago con el QR): esas se sustituyen por un token ANTES de escapar,
   * y se reinyectan después, para que su marcado sobreviva al escapado sin
   * abrir la puerta a HTML arbitrario desde el resto de la plantilla.
   */
  renderHtml(
    template: string,
    values: Record<string, string>,
    htmlValues: Record<string, string> = {},
  ): { html: string; missing: string[] } {
    const tokens = new Map<string, string>();
    const withTokens: Record<string, string> = { ...values };

    for (const [key, html] of Object.entries(htmlValues)) {
      if (!html) continue;
      const token = `@@BLOCK_${key.toUpperCase()}@@`;
      withTokens[key] = token;
      tokens.set(token, html);
    }

    const { text, missing } = this.render(template, withTokens);

    let body = escapeHtml(text)
      .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br />');

    for (const [token, html] of tokens) {
      // El token pasó por escapeHtml sin alterarse (solo letras, dígitos y @).
      body = body.split(token).join(html);
    }

    const html = [
      '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px;margin:0 auto;padding:24px">',
      body,
      '</div>',
    ].join('');

    return { html, missing };
  }

  /** Colapsa los huecos que dejan las variables vacías. */
  private tidy(text: string): string {
    return text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}
