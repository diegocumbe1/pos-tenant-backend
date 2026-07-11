// ─── Lynko Print Agent ──────────────────────────────────────────────────────
// Puente local nube ⇄ impresora LAN. Corre en un equipo DENTRO de la red del
// restaurante (laptop, mini-PC, Raspberry). El backend en la nube NO puede
// alcanzar 192.168.x.x:9100; este agente sí. Flujo:
//
//   1) Login → access_token.
//   2) Poll  GET  /restaurant/print-jobs/pending   (jobs QUEUED con datos de impresora)
//   3) Para cada job NETWORK: render ESC/POS → TCP a ip:9100 → ACK  (o FAIL)
//   4) Heartbeat: prueba TCP a cada impresora LAN activa → reporta online/offline
//
// Sin dependencias externas: usa `net` (TCP) y el `fetch` global de Node 18+.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToEscPos } from './escpos.mjs';

// ─── Carga robusta del .env ───────────────────────────────────────────────────
// Lee el `.env` que está JUNTO a este script (no depende del directorio actual
// ni del flag --env-file, que exige Node 20.6+). Tolera BOM y archivos guardados
// en UTF-16 (típico al guardarlos con Bloc de notas / PowerShell). No pisa
// variables que ya vengan del entorno (p.ej. las puestas con `set`).
const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(AGENT_DIR, '.env');

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
// Reintentos controlados ante fallos TCP transitorios (impresora ocupada, calentando,
// blip de red) antes de marcar el job como FAILED en el backend.
const SEND_RETRIES = Number(process.env.SEND_RETRIES ?? 3);
const SEND_RETRY_DELAY_MS = Number(process.env.SEND_RETRY_DELAY_MS ?? 1500);

const missing = ['AGENT_EMAIL', 'AGENT_PASSWORD', 'TENANT_ID', 'BRANCH_ID'].filter(
  (k) => !process.env[k],
);
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
/** Abre TCP a ip:port, envía bytes y resuelve al drenar. Rechaza en error/timeout. */
function sendToPrinter(ip, port, bytes) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.once('timeout', () => done(new Error('TCP timeout')));
    socket.once('error', (e) => done(e));
    socket.connect(port, ip, () => {
      socket.write(bytes, () => {
        // Pequeño respiro para que la impresora drene antes de cerrar.
        setTimeout(() => done(null), 250);
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
    // El agente solo maneja impresoras de red. USB lo imprime el navegador.
    if (!printer || printer.connection !== 'NETWORK') continue;
    if (!printer.ipAddress) {
      await failJob(job.id, 'Impresora LAN sin ipAddress configurada');
      continue;
    }
    const port = printer.port ?? 9100;
    try {
      const bytes = renderToEscPos(job.document, printer.paperWidth ?? 80);
      const attempts = await sendWithRetry(printer.ipAddress, port, bytes);
      await ackJob(job.id);
      log(
        `impreso job ${job.id} → ${printer.name} (${printer.ipAddress}:${port})` +
          (attempts > 1 ? ` [tras ${attempts} intentos]` : ''),
      );
    } catch (e) {
      await failJob(job.id, String(e?.message ?? e));
      log(`FALLO job ${job.id} → ${printer.ipAddress}:${port} tras ${SEND_RETRIES} intentos: ${e?.message ?? e}`);
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

// ─── Heartbeat de impresoras LAN ──────────────────────────────────────────────
async function heartbeat() {
  const res = await api('/restaurant/printers');
  if (!res.ok) return;
  const { printers = [] } = await res.json();
  for (const p of printers) {
    if (p.connection !== 'NETWORK' || !p.isActive || !p.ipAddress) continue;
    const online = await probePrinter(p.ipAddress, p.port ?? 9100);
    await api(`/restaurant/printers/${p.id}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ online }),
    });
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

async function main() {
  log(`Lynko Print Agent → ${API_URL} (tenant ${TENANT_ID} / branch ${BRANCH_ID})`);
  await login();
  // Dos bucles independientes: jobs (rápido) y heartbeat (lento).
  loop(drainJobs, POLL_MS, 'jobs');
  loop(heartbeat, HEARTBEAT_MS, 'heartbeat');
}

main().catch((e) => {
  console.error('[agent] fatal:', e);
  process.exit(1);
});
