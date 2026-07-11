import net from 'node:net';

const ESC = 0x1b;
const LF = 0x0a;

const ip = process.argv[2];
const port = Number(process.argv[3] ?? 9100);
const cut = process.argv.includes('--cut');

if (!ip) {
  console.error('Uso: node test-print.mjs <ip> [port] [--cut]');
  process.exit(1);
}

const text = [
  'LYNKO TEST DIRECTO',
  new Date().toISOString(),
  `Destino ${ip}:${port}`,
  'Si lees esto, ESC/POS funciona.',
  '',
  '',
].join('\n');

const bytes = [
  ESC,
  0x40,
  ...Buffer.from(text, 'ascii'),
  LF,
  LF,
  ...(cut ? [0x1d, 0x56, 0x42, 0x00] : []),
];

const socket = new net.Socket();
socket.setTimeout(4000);
socket.once('timeout', () => {
  console.error('timeout conectando a la impresora');
  socket.destroy();
  process.exit(1);
});
socket.once('error', (error) => {
  console.error(`error TCP: ${error.message}`);
  process.exit(1);
});
socket.connect(port, ip, () => {
  socket.write(Buffer.from(bytes), () => {
    setTimeout(() => {
      socket.destroy();
      console.log(`prueba enviada a ${ip}:${port}${cut ? ' con corte' : ' sin corte'}`);
    }, 300);
  });
});
