// Encoder ESC/POS: PrintDocument → Buffer (bytes para impresora térmica).
// Espejo de `verticals/restaurant/services/print-renderers/escpos.renderer.ts`
// del frontend: mismo PrintDocument → mismos bytes. Función pura, sin deps.

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const CR = 0x0d;

// Columnas de texto (Font A) según ancho de papel.
const COLS = { 58: 32, 80: 48 };
const ENABLE_NATIVE_QR = false;
const CUT_MODE = String(globalThis.process?.env?.CUT_MODE ?? 'partial').toLowerCase();
const CUT_FEED_UNITS = Math.max(
  0,
  Math.min(255, Number(globalThis.process?.env?.CUT_FEED_UNITS ?? 96) || 96),
);
const FULL_CUT_LF = Math.max(
  0,
  Math.min(10, Number(globalThis.process?.env?.FULL_CUT_LF ?? 3) || 3),
);

class ByteBuffer {
  constructor() {
    this.chunks = [];
  }
  push(...bytes) {
    this.chunks.push(...bytes);
  }
  text(s) {
    // ASCII estable para clones ESC/POS: evita mojibake por codepages.
    const safe = String(s ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[·•]/g, '-')
      .replace(/[^\x20-\x7e]/g, '?');
    for (let i = 0; i < safe.length; i++) {
      const code = safe.charCodeAt(i);
      this.chunks.push(code <= 0xff ? code : 0x3f /* '?' */);
    }
  }
  newline() {
    this.chunks.push(CR, LF);
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
  return left + '\r\n' + padded;
}

function wrapText(text, cols) {
  if (text.length <= cols) return [text];
  const lines = [];
  for (let i = 0; i < text.length; i += cols) lines.push(text.slice(i, i + cols));
  return lines;
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

function appendCut(buf) {
  if (CUT_MODE === 'full' || CUT_MODE === 'print3') {
    for (let i = 0; i < FULL_CUT_LF; i++) buf.newline();
    buf.push(GS, 0x56, 0x00);
    return;
  }
  // Alimenta y hace corte parcial en una sola orden; mejor para sensores/cutter.
  buf.push(GS, 0x56, 0x42, CUT_FEED_UNITS);
}

function normalizePublicReceiptUrl(value) {
  return String(value ?? '').replace(/^https?:\/\/lynko\.app(?=\/r\/)/i, 'https://uselynko.com');
}

function validQrData(value) {
  if (!String(value ?? '').trim()) return null;
  const normalized = normalizePublicReceiptUrl(String(value).trim());
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return normalized;
  } catch {
    return null;
  }
}

function appendBlock(buf, block, cols) {
  switch (block.kind) {
    case 'text':
      setAlign(buf, block.align ?? 'left');
      setBold(buf, !!block.bold);
      setSize(buf, block.size ?? 'md');
      buf.text(block.text ?? '');
      buf.newline();
      setSize(buf, 'md');
      setBold(buf, false);
      setAlign(buf, 'left');
      break;
    case 'line':
      setAlign(buf, 'left');
      buf.text('-'.repeat(cols));
      buf.newline();
      break;
    case 'row':
      setBold(buf, !!block.bold);
      buf.text(rowLine(block.left ?? '', block.right ?? '', cols));
      buf.newline();
      setBold(buf, false);
      break;
    case 'qr':
      {
        const data = validQrData(block.data);
        if (!data) break;
        setAlign(buf, 'center');
        if (ENABLE_NATIVE_QR) {
          appendQr(buf, data, block.size);
        } else {
          buf.text('Recibo digital');
          buf.newline();
          for (const line of wrapText(data, cols)) {
            buf.text(line);
            buf.newline();
          }
        }
      }
      buf.newline();
      setAlign(buf, 'left');
      break;
    case 'barcode':
      setAlign(buf, 'center');
      buf.text(block.data ?? '');
      buf.newline();
      setAlign(buf, 'left');
      break;
    case 'image':
      // Logos por raster no soportados todavía — se omite.
      break;
    case 'feed':
      buf.push(ESC, 0x64, Math.max(0, Math.min(255, block.lines ?? 1)));
      break;
    case 'cut':
      appendCut(buf);
      break;
    case 'drawer':
      buf.push(ESC, 0x70, 0x00, 0x19, 0xfa); // abrir cajón monedero (pin 2)
      break;
    default:
      break;
  }
}

/** PrintDocument → Buffer ESC/POS listo para enviar por TCP. */
export function renderToEscPos(doc, paperWidth = 80) {
  const cols = COLS[paperWidth] ?? 48;
  const buf = new ByteBuffer();
  buf.push(ESC, 0x40); // init
  buf.push(ESC, 0x4d, 0x00); // Font A
  buf.push(ESC, 0x21, 0x00); // estilo normal
  buf.push(ESC, 0x32); // interlineado default
  buf.push(ESC, 0x33, 0x18); // interlineado 24 dots, común en clones
  buf.push(ESC, 0x74, 0x00); // codepage PC437, fallback seguro para texto ASCII
  const blocks = doc.blocks ?? [];
  for (const block of blocks) appendBlock(buf, block, cols);
  // Avance final SOLO si el documento no terminó en corte. Alimentar tras cortar
  // empuja papel nuevo sobre el sensor (al medio) y deja el "recordatorio de pedido"
  // pitando aunque retiren la comanda; el bloque `cut` ya alimenta antes de cortar.
  if (blocks[blocks.length - 1]?.kind !== 'cut') buf.push(CR, LF, CR, LF);
  return buf.toBuffer();
}

export function renderPlainTextTest() {
  const buf = new ByteBuffer();
  buf.push(ESC, 0x40, ESC, 0x4d, 0x00, ESC, 0x21, 0x00, ESC, 0x32);
  buf.text('LYNKO TEST RAW');
  buf.newline();
  buf.text('Si lees esto, LAN 9100 imprime texto.');
  buf.newline();
  buf.text('DigitalPOS compatible RAW/ESC-POS');
  buf.newline();
  appendCut(buf);
  return buf.toBuffer();
}
