// Encoder ESC/POS: PrintDocument → Buffer (bytes para impresora térmica).
// Espejo de `verticals/restaurant/services/print-renderers/escpos.renderer.ts`
// del frontend: mismo PrintDocument → mismos bytes. Función pura, sin deps.

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

// Columnas de texto (Font A) según ancho de papel.
const COLS = { 58: 32, 80: 48 };

class ByteBuffer {
  constructor() {
    this.chunks = [];
  }
  push(...bytes) {
    this.chunks.push(...bytes);
  }
  text(s) {
    // latin1 best-effort (acentos dependen del codepage del equipo).
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      this.chunks.push(code <= 0xff ? code : 0x3f /* '?' */);
    }
  }
  toBuffer() {
    return Buffer.from(this.chunks);
  }
}

function setAlign(buf, align) {
  buf.push(ESC, 0x61, align === 'center' ? 1 : align === 'right' ? 2 : 0);
}
function setBold(buf, on) {
  buf.push(ESC, 0x45, on ? 1 : 0);
}
function setSize(buf, size) {
  const n = size === 'lg' ? 0x11 : 0x00;
  buf.push(GS, 0x21, n);
}

function rowLine(left, right, cols) {
  const gap = cols - left.length - right.length;
  if (gap >= 1) return left + ' '.repeat(gap) + right;
  const padded =
    right.length >= cols ? right.slice(0, cols) : ' '.repeat(cols - right.length) + right;
  return left + '\n' + padded;
}

// QR vía GS ( k (modelo 2).
function appendQr(buf, data, moduleSize = 6) {
  const size = Math.max(3, Math.min(16, moduleSize));
  buf.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);
  buf.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size);
  buf.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31);
  const bytes = [];
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    bytes.push(c <= 0xff ? c : 0x3f);
  }
  const len = bytes.length + 3;
  buf.push(GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30, ...bytes);
  buf.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);
}

function appendBlock(buf, block, cols, options = {}) {
  switch (block.kind) {
    case 'text':
      setAlign(buf, block.align ?? 'left');
      setBold(buf, !!block.bold);
      setSize(buf, block.size ?? 'md');
      buf.text(block.text ?? '');
      buf.push(LF);
      setSize(buf, 'md');
      setBold(buf, false);
      setAlign(buf, 'left');
      break;
    case 'line':
      setAlign(buf, 'left');
      buf.text('-'.repeat(cols));
      buf.push(LF);
      break;
    case 'row':
      setBold(buf, !!block.bold);
      buf.text(rowLine(block.left ?? '', block.right ?? '', cols));
      buf.push(LF);
      setBold(buf, false);
      break;
    case 'qr':
      setAlign(buf, 'center');
      appendQr(buf, block.data ?? '', block.size);
      buf.push(LF);
      setAlign(buf, 'left');
      break;
    case 'barcode':
      setAlign(buf, 'center');
      buf.text(block.data ?? '');
      buf.push(LF);
      setAlign(buf, 'left');
      break;
    case 'image':
      // Logos por raster no soportados todavía — se omite.
      break;
    case 'feed':
      buf.push(ESC, 0x64, Math.max(0, Math.min(255, block.lines ?? 1)));
      break;
    case 'cut':
      if (!options.disableCut) {
        buf.push(GS, 0x56, 0x42, 0x00); // corte parcial
      }
      break;
    case 'drawer':
      buf.push(ESC, 0x70, 0x00, 0x19, 0xfa); // abrir cajón monedero (pin 2)
      break;
    default:
      break;
  }
}

/** PrintDocument → Buffer ESC/POS listo para enviar por TCP. */
export function renderToEscPos(doc, paperWidth = 80, options = {}) {
  const cols = COLS[paperWidth] ?? 48;
  const buf = new ByteBuffer();
  const hasKitchenCut =
    doc.printerTarget === 'KITCHEN' &&
    (doc.blocks ?? []).some((block) => block.kind === 'cut');
  buf.push(ESC, 0x40); // init
  for (const block of doc.blocks ?? []) appendBlock(buf, block, cols, options);
  if (!hasKitchenCut) buf.push(LF, LF); // caja/otros mantienen el avance previo
  return buf.toBuffer();
}
