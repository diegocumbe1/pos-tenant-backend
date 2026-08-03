// ─── Lynko Print Agent ──────────────────────────────────────────────────────
// Puente local nube ⇄ impresora. Corre en un equipo DENTRO de la red del
// restaurante (laptop, mini-PC, Raspberry). El backend en la nube NO puede
// alcanzar 192.168.x.x:9100 ni una cola USB local de Windows; este agente sí. Flujo:
//
//   1) Login → access_token.
//   2) Poll  GET  /restaurant/print-jobs/pending   (jobs QUEUED con datos de impresora)
//   3) Job NETWORK: render ESC/POS → TCP a ip:9100 → ACK  (o FAIL)
//      Job AGENT: render ESC/POS → cola RAW de Windows por nombre → ACK (o FAIL)
//   4) Heartbeat: prueba cada impresora activa → reporta online/offline
//
// Sin dependencias externas: usa `net` (TCP) y el `fetch` global de Node 18+.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { renderPlainTextTest, renderToEscPos } from './escpos.mjs';

// ─── Carga robusta del .env ───────────────────────────────────────────────────
// Lee el `.env` que está JUNTO a este script (no depende del directorio actual
// ni del flag --env-file, que exige Node 20.6+). Tolera BOM y archivos guardados
// en UTF-16 (típico al guardarlos con Bloc de notas / PowerShell). No pisa
// variables que ya vengan del entorno (p.ej. las puestas con `set`).
const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(AGENT_DIR, '.env');
const RAW_PRINT_SCRIPT = path.join(AGENT_DIR, 'raw-print.ps1');
const execFileAsync = promisify(execFile);

function loadDotEnv(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return false; // no hay .env → quizá las variables vienen del entorno
  }
  // Detecta codificación: UTF-16LE si hay bytes nulos intercalados o BOM FF FE.
  let text;
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf.length > 1 && buf[1] === 0x00)) {
    text = buf.toString('utf16le');
  } else {
    text = buf.toString('utf8');
  }
  text = text.replace(/^﻿/, ''); // quita BOM UTF-8
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
  return true;
}

const envLoaded = loadDotEnv(ENV_PATH);

// ─── Config (variables de entorno) ───────────────────────────────────────────
const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const EMAIL = process.env.AGENT_EMAIL;
const PASSWORD = process.env.AGENT_PASSWORD;
const TENANT_ID = process.env.TENANT_ID;
const BRANCH_ID = process.env.BRANCH_ID;
const POLL_MS = Number(process.env.POLL_MS ?? 3000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 20000);
const TCP_TIMEOUT_MS = Number(process.env.TCP_TIMEOUT_MS ?? 4000);
const TCP_DRAIN_WAIT_MS = Number(process.env.TCP_DRAIN_WAIT_MS ?? 1200);
const STATUS_QUERY_ENABLED = String(process.env.STATUS_QUERY_ENABLED ?? 'false').toLowerCase() === 'true';
// Sondeo TCP ANTES de imprimir. Por defecto DESACTIVADO: abrir+cerrar una conexión
// extra justo antes de cada comanda descuadra el buzzer de algunos clones ESC/POS
// (pita sin parar de la 2ª impresión en adelante). Sin sondeo, el agente hace una
// sola conexión limpia por trabajo, igual que el driver de Windows. Si el envío
// falla, el reintento/So catch ya marca la impresora offline. Ponlo en 'true' solo
// si necesitas el chequeo previo de alcanzabilidad.
const PREPRINT_PROBE = String(process.env.PREPRINT_PROBE ?? 'false').toLowerCase() === 'true';
// Reintentos controlados ante fallos TCP transitorios (impresora ocupada, calentando,
// blip de red) antes de marcar el job como FAILED en el backend.
const SEND_RETRIES = Number(process.env.SEND_RETRIES ?? 3);
const SEND_RETRY_DELAY_MS = Number(process.env.SEND_RETRY_DELAY_MS ?? 1500);
// Evita que, al prender de nuevo el PC/agente, se impriman comandas viejas que
// quedaron QUEUED durante una caída. 10 min deja pasar trabajos recientes tras
// un reinicio corto, pero corta el backlog peligroso de horas/días.
const JOB_MAX_AGE_MS = Number(process.env.JOB_MAX_AGE_MS ?? 10 * 60 * 1000);

function isMissingConfigValue(key) {
  const value = process.env[key]?.trim();
  if (!value) return true;
  if (key === 'AGENT_PASSWORD' && value === 'tu-contraseña-de-lynko') return true;
  if (key === 'AGENT_EMAIL' && value === 'dueño@turestaurante.com') return true;
  return value.startsWith('<') && value.endsWith('>');
}

const missing = ['AGENT_EMAIL', 'AGENT_PASSWORD', 'TENANT_ID', 'BRANCH_ID'].filter(isMissingConfigValue);
if (missing.length > 0) {
  console.error('[agent] Faltan variables: ' + missing.join(', '));
  console.error('[agent] Archivo .env buscado en: ' + ENV_PATH);
  console.error(
    envLoaded
      ? '[agent] El .env existe pero no define esas variables (revisa que no esté vacío y que sea texto UTF-8).'
      : '[agent] No se encontró .env en esa ruta. Créalo ahí, o pásalas con `set NOMBRE=valor` antes de `node agent.mjs`.',
  );
  process.exit(1);
}

let accessToken = null;

const log = (...a) => console.log(`[agent ${new Date().toISOString()}]`, ...a);

function parseJobCreatedAt(job) {
  const raw = job?.createdAt ?? job?.document?.createdAt;
  if (!raw) return null;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : null;
}

function isStaleJob(job) {
  if (!Number.isFinite(JOB_MAX_AGE_MS) || JOB_MAX_AGE_MS <= 0) return false;
  const createdAt = parseJobCreatedAt(job);
  if (!createdAt) return false;
  return Date.now() - createdAt > JOB_MAX_AGE_MS;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function authHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'X-Tenant-Id': TENANT_ID,
    'X-Branch-Id': BRANCH_ID,
  };
}

async function login() {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login ${res.status}: ${await res.text()}`);
  const data = await res.json();
  accessToken = data.access_token ?? data.accessToken;
  if (!accessToken) throw new Error('login sin access_token');
  log('sesión iniciada');
}

/** Llama la API reintentando login una vez ante 401 (token expirado). */
async function api(path, init = {}, retry = true) {
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: authHeaders() });
  if (res.status === 401 && retry) {
    await login();
    return api(path, init, false);
  }
  return res;
}

// ─── TCP a la impresora ───────────────────────────────────────────────────────
/** Abre TCP a ip:port, envía bytes y resuelve al drenar. Rechaza en error/timeout.
 *  Cierre limpio (FIN) como el driver de Windows: tras escribir, hace `end()` y
 *  espera a que la impresora cierre su lado; solo si tarda de más fuerza el cierre.
 *  Nunca corta en seco (RST), que descuadra el buzzer de algunos clones. */
function sendToPrinter(ip, port, bytes) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    let drainTimer = null;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.once('timeout', () => done(new Error('TCP timeout')));
    socket.once('error', (e) => done(e));
    // La impresora cierra su lado tras procesar → cierre grácil sin RST.
    socket.once('close', () => done(null));
    socket.connect(port, ip, () => {
      socket.write(bytes, () => {
        socket.end(); // envía FIN; esperamos el 'close' de la impresora.
        // Red de seguridad: si la impresora no cierra, resolvemos igual tras drenar.
        drainTimer = setTimeout(() => done(null), TCP_DRAIN_WAIT_MS);
      });
    });
  });
}

/** Envía con reintentos controlados: reintenta fallos transitorios y, si todos
 *  fallan, propaga el último error para marcar el job FAILED. */
async function sendWithRetry(ip, port, bytes) {
  let lastErr;
  for (let attempt = 1; attempt <= Math.max(1, SEND_RETRIES); attempt++) {
    try {
      await sendToPrinter(ip, port, bytes);
      return attempt; // éxito
    } catch (e) {
      lastErr = e;
      if (attempt < SEND_RETRIES) {
        log(`reintento ${attempt}/${SEND_RETRIES - 1} → ${ip}:${port}: ${e?.message ?? e}`);
        await new Promise((r) => setTimeout(r, SEND_RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

/** Prueba de conectividad: ¿acepta la impresora una conexión TCP? */
function probePrinter(ip, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (online) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(online);
    };
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, ip, () => finish(true));
  });
}

/** Consulta estado ESC/POS en impresoras que soportan respuesta bidireccional.
 *  Si la impresora no responde estado, devolvemos null y usamos solo TCP. */
function readPrinterPaperStatus(ip, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(status);
    };
    socket.setTimeout(1200);
    socket.once('timeout', () => finish(null));
    socket.once('error', () => finish(null));
    socket.once('data', (chunk) => {
      const value = chunk?.[0] ?? 0;
      // DLE EOT 4: en ESC/POS común, bits 5/6 indican fin de papel.
      finish({ paperOut: (value & 0x60) !== 0, raw: value });
    });
    socket.connect(port, ip, () => {
      socket.write(Buffer.from([0x10, 0x04, 0x04]));
    });
  });
}

async function probePrinterReady(ip, port) {
  const tcpOnline = await probePrinter(ip, port);
  if (!tcpOnline) return { online: false, reason: 'tcp_offline' };
  if (!STATUS_QUERY_ENABLED) return { online: true, reason: 'tcp_only_status_disabled' };
  const paper = await readPrinterPaperStatus(ip, port);
  if (paper?.paperOut) return { online: false, reason: `paper_out status=${paper.raw}` };
  return { online: true, reason: paper ? `ready status=${paper.raw}` : 'tcp_only' };
}

// ─── Windows RAW printing ─────────────────────────────────────────────────────
// Para impresoras USB instaladas en Windows mantenemos el driver normal del SO y
// escribimos ESC/POS como trabajo RAW en la cola por nombre. No requiere Zadig.
const RAW_PRINT_PS1 = [
  'param(',
  '  [Parameter(Mandatory=$true)][string]$PrinterName,',
  '  [Parameter(Mandatory=$true)][string]$FilePath',
  ')',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class RawPrinterHelper {',
  '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]',
  '  public class DOCINFOA {',
  '    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;',
  '    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;',
  '    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;',
  '  }',
  '  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]',
  '  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);',
  '  [DllImport("winspool.Drv", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]',
  '  public static extern bool ClosePrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]',
  '  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In] DOCINFOA di);',
  '  [DllImport("winspool.Drv", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]',
  '  public static extern bool EndDocPrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.Drv", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]',
  '  public static extern bool StartPagePrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.Drv", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]',
  '  public static extern bool EndPagePrinter(IntPtr hPrinter);',
  '  [DllImport("winspool.Drv", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]',
  '  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);',
  '  public static bool SendBytesToPrinter(string printerName, byte[] bytes) {',
  '    IntPtr hPrinter;',
  '    DOCINFOA di = new DOCINFOA();',
  '    di.pDocName = "Lynko ESC/POS";',
  '    di.pDataType = "RAW";',
  '    if (!OpenPrinter(printerName.Normalize(), out hPrinter, IntPtr.Zero)) return false;',
  '    try {',
  '      if (!StartDocPrinter(hPrinter, 1, di)) return false;',
  '      if (!StartPagePrinter(hPrinter)) return false;',
  '      IntPtr pBytes = Marshal.AllocCoTaskMem(bytes.Length);',
  '      try {',
  '        Marshal.Copy(bytes, 0, pBytes, bytes.Length);',
  '        int written = 0;',
  '        bool ok = WritePrinter(hPrinter, pBytes, bytes.Length, out written);',
  '        return ok && written == bytes.Length;',
  '      } finally {',
  '        Marshal.FreeCoTaskMem(pBytes);',
  '        EndPagePrinter(hPrinter);',
  '        EndDocPrinter(hPrinter);',
  '      }',
  '    } finally {',
  '      ClosePrinter(hPrinter);',
  '    }',
  '  }',
  '}',
  '"@',
  '$bytes = [System.IO.File]::ReadAllBytes($FilePath)',
  '$ok = [RawPrinterHelper]::SendBytesToPrinter($PrinterName, $bytes)',
  "if (-not $ok) { throw \"No se pudo imprimir RAW en '$PrinterName'\" }",
].join('\r\n');

function ensureWindowsRawPrintScript() {
  if (!fs.existsSync(RAW_PRINT_SCRIPT) || fs.readFileSync(RAW_PRINT_SCRIPT, 'utf8') !== RAW_PRINT_PS1) {
    fs.writeFileSync(RAW_PRINT_SCRIPT, RAW_PRINT_PS1, 'utf8');
  }
}

async function sendToWindowsPrinter(printerName, bytes) {
  if (process.platform !== 'win32') {
    throw new Error('La conexión AGENT requiere Windows para imprimir por cola USB local');
  }
  ensureWindowsRawPrintScript();
  const tmpFile = path.join(os.tmpdir(), `lynko-print-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`);
  fs.writeFileSync(tmpFile, bytes);
  try {
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RAW_PRINT_SCRIPT, '-PrinterName', printerName, '-FilePath', tmpFile],
      { windowsHide: true, timeout: 20000 },
    );
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
  }
}

async function windowsPrinterExists(printerName) {
  if (process.platform !== 'win32' || !printerName) return false;
  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '$name=$args[0]; if (Get-Printer -Name $name -ErrorAction SilentlyContinue) { exit 0 } else { exit 2 }',
        printerName,
      ],
      { windowsHide: true, timeout: 8000 },
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Ciclo de jobs ────────────────────────────────────────────────────────────
async function drainJobs() {
  const res = await api('/restaurant/print-jobs/pending');
  if (!res.ok) {
    log('pending error', res.status);
    return;
  }
  const { jobs = [] } = await res.json();
  for (const job of jobs) {
    const printer = job.printer;
    if (!printer || (printer.connection !== 'NETWORK' && printer.connection !== 'AGENT')) continue;
    if (isStaleJob(job)) {
      const createdAt = job.createdAt ?? job.document?.createdAt ?? 'fecha desconocida';
      const ageMin = Math.round((Date.now() - (parseJobCreatedAt(job) ?? Date.now())) / 60000);
      await failJob(job.id, `Job descartado por antigüedad (${ageMin} min, creado ${createdAt})`);
      log(`DESCARTADO job viejo ${job.id} → ${printer.name} (${ageMin} min, creado ${createdAt})`);
      continue;
    }
    try {
      const isDiagnosticTest = String(job.document?.id ?? '').startsWith('TEST-');
      const bytes = isDiagnosticTest
        ? renderPlainTextTest()
        : renderToEscPos(job.document, printer.paperWidth ?? 80);
      if (printer.connection === 'NETWORK') {
        if (!printer.ipAddress) {
          await failJob(job.id, 'Impresora LAN sin ipAddress configurada');
          continue;
        }
        const port = printer.port ?? 9100;
        // Sondeo previo opcional (por defecto OFF): la conexión extra descuadra el
        // buzzer de algunos clones. Sin él, imprimimos directo — una sola conexión.
        if (PREPRINT_PROBE) {
          const ready = await probePrinterReady(printer.ipAddress, port);
          if (!ready.online) {
            await markPrinterOnline(printer.id, false);
            await failJob(job.id, `Impresora no lista: ${ready.reason}`);
            log(`NO LISTA job ${job.id} → ${printer.name} (${printer.ipAddress}:${port}) ${ready.reason}`);
            continue;
          }
        }
        const attempts = await sendWithRetry(printer.ipAddress, port, bytes);
        await ackJob(job.id);
        await markPrinterOnline(printer.id, true);
        log(
          `impreso job ${job.id} → ${printer.name} (${printer.ipAddress}:${port})` +
            (isDiagnosticTest ? ' [RAW TEST]' : '') +
            (attempts > 1 ? ` [tras ${attempts} intentos]` : ''),
        );
        continue;
      }
      if (!printer.address) {
        await failJob(job.id, 'Impresora Windows/USB sin nombre de impresora configurado');
        continue;
      }
      await sendToWindowsPrinter(printer.address, bytes);
      await ackJob(job.id);
      await markPrinterOnline(printer.id, true);
      log(`impreso job ${job.id} → ${printer.name} (Windows: ${printer.address})`);
    } catch (e) {
      await failJob(job.id, String(e?.message ?? e));
      const target = printer.connection === 'AGENT' ? printer.address : `${printer.ipAddress}:${printer.port ?? 9100}`;
      log(`FALLO job ${job.id} → ${target}: ${e?.message ?? e}`);
    }
  }
}

async function ackJob(id) {
  await api(`/restaurant/print-jobs/${id}/ack`, { method: 'POST' });
}
async function failJob(id, error) {
  await api(`/restaurant/print-jobs/${id}/fail`, {
    method: 'POST',
    body: JSON.stringify({ error }),
  });
}
async function markPrinterOnline(id, online) {
  const res = await api(`/restaurant/printers/${id}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify({ online }),
  });
  if (!res.ok) {
    log(`heartbeat update error printer=${id} online=${online}: ${res.status} ${await res.text()}`);
  }
}

// ─── Heartbeat de impresoras del agente ───────────────────────────────────────
async function heartbeat() {
  const res = await api('/restaurant/printers');
  if (!res.ok) return;
  const { printers = [] } = await res.json();
  for (const p of printers) {
    if (!p.isActive) continue;
    let online = false;
    if (p.connection === 'NETWORK' && p.ipAddress) {
      const status = await probePrinterReady(p.ipAddress, p.port ?? 9100);
      online = status.online;
      if (!online) log(`printer offline ${p.name} (${p.ipAddress}:${p.port ?? 9100}) ${status.reason}`);
    } else if (p.connection === 'AGENT' && p.address) {
      online = await windowsPrinterExists(p.address);
    } else {
      continue;
    }
    await markPrinterOnline(p.id, online);
  }
}

// ─── Bucles ───────────────────────────────────────────────────────────────────
async function loop(fn, everyMs, label) {
  for (;;) {
    try {
      await fn();
    } catch (e) {
      log(`${label} error:`, e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Login de arranque con reintentos. Un 401 sí es fatal: las credenciales están
 *  mal y reintentar no lo arregla, alguien tiene que corregir el .env. Cualquier
 *  fallo de red se reintenta indefinidamente con backoff, porque el agente corre
 *  en el local del cliente sobre una conexión que pierde paquetes, y morirse al
 *  arrancar deja la cocina sin imprimir hasta que vayan a reiniciarlo a mano. */
async function loginWithRetry() {
  const MAX_DELAY_MS = 30_000;
  let delay = 1_000;
  for (;;) {
    try {
      await login();
      return;
    } catch (e) {
      const msg = e?.message ?? String(e);
      if (msg.startsWith('login 401:')) throw e;
      log(`login falló (${msg}); reintento en ${Math.round(delay / 1000)}s`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
}

async function main() {
  log(`Lynko Print Agent → ${API_URL} (tenant ${TENANT_ID} / branch ${BRANCH_ID})`);
  await loginWithRetry();
  // Dos bucles independientes: jobs (rápido) y heartbeat (lento).
  loop(drainJobs, POLL_MS, 'jobs');
  loop(heartbeat, HEARTBEAT_MS, 'heartbeat');
}

main().catch((e) => {
  console.error('[agent] fatal:', e);
  process.exit(1);
});
