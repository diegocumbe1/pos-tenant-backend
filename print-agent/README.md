# Lynko Print Agent

Puente local entre **Lynko POS (nube)** y las **impresoras térmicas LAN** del restaurante
(Digital POS DIG-E200I / DIG-D300I y compatibles ESC/POS por puerto `9100`).

## ¿Por qué existe?

El backend en la nube **no puede** alcanzar una IP privada como `192.168.1.150:9100`.
Este agente corre en un equipo **dentro de la red del local** (laptop, mini-PC o
Raspberry Pi), lee los trabajos de impresión encolados en la nube y los envía por
TCP directo a la impresora. Cualquier dispositivo de la sede (tablet, celular, PC)
manda la comanda por la API; el agente la imprime.

```
Tablet/PC/Celular ──API──▶ Lynko (nube)  ──cola──▶  [este agente, en la LAN]  ──TCP:9100──▶  Impresora
```

Las impresoras **USB** NO pasan por el agente: las imprime el navegador vía WebUSB.

## Requisitos

- Node.js 18 o superior.
- El equipo debe estar en la misma red que las impresoras.
- Un usuario Lynko con permisos `restaurant:print:*` y `restaurant:printers:manage`.

## Uso

```bash
cd print-agent
cp .env.example .env      # edita credenciales, TENANT_ID, BRANCH_ID y API_URL
npm start
```

No hay dependencias que instalar: usa solo módulos nativos de Node (`net`, `fetch`).

## Qué hace

- **Jobs** (cada `POLL_MS`): `GET /restaurant/print-jobs/pending` → por cada job de una
  impresora `NETWORK`, renderiza ESC/POS y lo envía a `ip:port`; luego `ack` o `fail`.
- **Heartbeat** (cada `HEARTBEAT_MS`): prueba TCP a cada impresora LAN activa y reporta
  `online/offline` (`POST /restaurant/printers/:id/heartbeat`) para el estado en Ajustes.

## Producción

Ejecútalo como servicio para que arranque solo y se reinicie:

- **systemd** (Linux/Raspberry): crea un unit que corra `node --env-file=.env agent.mjs`.
- **pm2**: `pm2 start agent.mjs --name lynko-print-agent`.
