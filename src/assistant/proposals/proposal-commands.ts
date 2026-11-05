/**
 * Las órdenes que manejan un borrador. Son exactas a propósito: un "sí" dentro
 * de una frase no aprueba nada, y una ráfaga unida ("SI 4821\nNO") tampoco.
 */
export type ProposalCommand =
  | { type: 'confirm'; code: string }
  | { type: 'reject'; code: string }
  | { type: 'inspect'; code: string }
  | { type: 'list' }
  | { type: 'bare_yes' }
  | { type: 'bare_no' }
  | { type: 'help' }
  | { type: 'unsupported'; what: string };

export function normalizeCommand(message: string): string {
  return message
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!.,]/g, ' ')
    .trim()
    .replace(/[ \t]+/g, ' ');
}

export function parseProposalCommand(message: string): ProposalCommand | null {
  const text = normalizeCommand(message);

  let found = /^(?:si|confirmo|confirmar)\s(\d{4})$/.exec(text);
  if (found) return { type: 'confirm', code: found[1] };

  found = /^(?:no|cancelar|cancela|cancelo)\s(\d{4})$/.exec(text);
  if (found) return { type: 'reject', code: found[1] };

  found =
    /^(?:que es|que era|ver|cual es)(?:\sel)?(?:\scodigo|\sborrador)?\s(\d{4})$/.exec(
      text,
    );
  if (found) return { type: 'inspect', code: found[1] };

  if (/^(?:pendientes|borradores|mis borradores)$/.test(text)) {
    return { type: 'list' };
  }
  if (
    /^(?:si|ok|dale|listo|confirmo|confirmar|confirmado|correcto|de una)$/.test(
      text,
    )
  ) {
    return { type: 'bare_yes' };
  }
  if (/^(?:no|cancelar|cancela|cancelo)$/.test(text)) {
    return { type: 'bare_no' };
  }
  if (/^(?:registrar|que puedo registrar|ayuda registrar)$/.test(text)) {
    return { type: 'help' };
  }

  found =
    /^(?:registrar|registra|anotar|anota)\s(?:una?\s)?(cita|cobro|abono)\b/.exec(
      text,
    );
  if (found) return { type: 'unsupported', what: found[1] };

  return null;
}
