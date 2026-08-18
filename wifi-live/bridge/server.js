// wifi-live bridge
//
// Reads CSV frame records from the ESP32 over USB serial, decodes them, and
// fans them out to the browser over a WebSocket. Also serves ../web.
//
//   node server.js --simulate                 # no hardware needed
//   node server.js --port /dev/cu.usbserial-0001
//   node server.js --list-ports
//
// Frames are batched on a 50ms tick. At a busy 2.4GHz channel you can see
// several thousand frames per second, and one WS message per frame will
// bury the renderer.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { parseLine } from './decode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');

// ---- args -------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const SIMULATE  = !!flag('simulate', false);
const LIST      = !!flag('list-ports', false);
const SERIAL    = flag('port', null);
const BAUD      = Number(flag('baud', 921600));
const HTTP_PORT = Number(flag('http', 8080));

// ---- fanout -----------------------------------------------------------

let batch = [];
let seen = 0;

function emit(pkt) {
  seen++;
  batch.push(pkt);
  if (batch.length > 4000) batch = batch.slice(-4000);  // renderer backpressure
}

// ---- serial source ----------------------------------------------------

async function startSerial() {
  let SerialPort, ReadlineParser;
  try {
    ({ SerialPort, ReadlineParser } = await import('serialport'));
  } catch {
    console.error(
      'serialport is not installed (it is an optional dependency).\n' +
      '  npm install serialport\n' +
      'Or run without hardware:  npm run sim'
    );
    process.exit(1);
  }

  if (LIST) {
    const ports = await SerialPort.list();
    if (!ports.length) console.log('No serial ports found.');
    for (const p of ports) {
      console.log(`${p.path}\t${p.manufacturer ?? 'unknown'}\t${p.productId ?? ''}`);
    }
    process.exit(0);
  }

  let target = SERIAL;
  if (!target) {
    const ports = await SerialPort.list();
    // ESP32 dev boards show up as a USB-UART bridge: CP2102, CH340, or native USB.
    const guess = ports.find((p) => /usbserial|SLAB|wchusbserial|usbmodem/i.test(p.path));
    if (!guess) {
      console.error('No serial port given and none auto-detected. Try --list-ports.');
      process.exit(1);
    }
    target = guess.path;
    console.log(`auto-detected ${target}`);
  }

  const port = new SerialPort({ path: target, baudRate: BAUD });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  port.on('open', () => console.log(`serial open  ${target} @ ${BAUD}`));
  port.on('error', (e) => console.error('serial error:', e.message));

  parser.on('data', (line) => {
    // The firmware reports ring-buffer overflow as "# dropped N". Surfacing it
    // matters: a silent overflow looks exactly like a quiet channel.
    if (line.startsWith('# dropped')) {
      console.log(`\n${line.trim()} frames (serial link behind; raise BAUD or RB_SIZE)`);
      return;
    }
    const pkt = parseLine(line);
    if (pkt) emit(pkt);
  });
}

// ---- simulator --------------------------------------------------------
// Plausible-enough traffic so the renderer can be built and tuned without
// waiting for hardware. Deliberately mirrors the real shape: beacons at a
// steady ~10Hz per AP, bursty data from clients, a haze of ACKs.

function startSimulator() {
  console.log('simulator mode: synthetic traffic, no radio involved');

  const mk = (mac, rssi, isAp) => ({ mac, rssi, isAp, phase: Math.random() * 6.28 });
  const nodes = [
    mk('A4:2B:8C:11:03:F1', -42, true),   // near AP
    mk('E8:9F:80:5C:22:AB', -71, true),   // neighbour AP
    mk('F0:18:98:74:19:0C', -48, false),  // laptop
    mk('DC:A6:32:8E:44:2D', -55, false),  // phone
    mk('B8:27:EB:03:9A:71', -63, false),  // pi
    mk('9C:64:8B:D2:07:55', -79, false),  // distant thing
  ];

  let t = 0;
  setInterval(() => {
    t += 0.05;
    for (const n of nodes) {
      // slow RSSI wander, the way a real link breathes
      const rssi = Math.round(n.rssi + 3 * Math.sin(t * 0.7 + n.phase) + (Math.random() * 4 - 2));

      if (n.isAp) {
        // beacon interval is 102.4ms, so ~1 every other 50ms tick
        if (Math.random() < 0.5) {
          emit({ rssi, cls: 'mgmt', name: 'beacon', len: 280, mac: n.mac, ch: 6 });
        }
      } else {
        // bursty: mostly quiet, occasionally a run of QoS data + acks
        if (Math.random() < 0.22) {
          const burst = 1 + Math.floor(Math.random() * 12);
          for (let i = 0; i < burst; i++) {
            emit({
              rssi, cls: 'data', name: 'qos-data',
              len: 200 + Math.floor(Math.random() * 1300),
              mac: n.mac, ch: 6,
            });
            if (Math.random() < 0.8) {
              emit({ rssi: rssi + 1, cls: 'ctrl', name: 'ack', len: 14, mac: n.mac, ch: 6 });
            }
          }
        }
        if (Math.random() < 0.03) {
          emit({ rssi, cls: 'mgmt', name: 'probe-req', len: 68, mac: n.mac, ch: 6 });
        }
      }
    }
  }, 50);
}

// ---- http + ws --------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(WEB_DIR, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  console.log(`viewer connected (${wss.clients.size} total)`);
  ws.on('close', () => console.log(`viewer left (${wss.clients.size} total)`));
});

setInterval(() => {
  if (!batch.length || !wss.clients.size) { batch = []; return; }
  const msg = JSON.stringify({ t: Date.now(), pkts: batch });
  batch = [];
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}, 50);

// Plain lines, not a \r-rewritten status. The carriage-return version
// interleaved with console.log and silently ate the connect/disconnect
// messages, which made "no viewer ever connected" indistinguishable from
// "the log scrolled past it".
let lastSeen = 0;
setInterval(() => {
  const rate = Math.round((seen - lastSeen) / 5);
  lastSeen = seen;
  console.log(`${new Date().toISOString().slice(11, 19)}  ${rate}/s  ${seen} total  ${wss.clients.size} viewer(s)`);
}, 5000);

server.listen(HTTP_PORT, () => {
  console.log(`viewer  http://localhost:${HTTP_PORT}`);
  if (SIMULATE) startSimulator();
  else startSerial();
});
