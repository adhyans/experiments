// wifi-live viewer
//
// Centre of the screen is your ESP32 sitting on the table. Every transmitter
// it hears gets a node, placed at a stable angle (hashed from its MAC) and a
// radius set by signal strength. Each frame received spawns a particle that
// travels inward, because that is what physically happened: a burst of
// 2.4GHz left that device and arrived at your antenna.

const C = {
  data: [53, 224, 208],
  mgmt: [139, 124, 255],
  ctrl: [240, 168, 60],
  unknown: [110, 130, 150],
};

const RSSI_STRONG = -30;   // maps to the inner ring
const RSSI_WEAK   = -95;   // maps to the outer ring
const RINGS       = [-40, -55, -70, -85];

const cv = document.getElementById('c');
const ctx = cv.getContext('2d', { alpha: false });

let W = 0, H = 0, CX = 0, CY = 0, R_IN = 0, R_OUT = 0, DPR = 1;

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  cv.width = W * DPR;
  cv.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  CX = W / 2;
  CY = H / 2;
  R_IN = 78;
  R_OUT = Math.min(W, H) * 0.44;
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, W, H);
}
window.addEventListener('resize', resize);
resize();

// ---- placement --------------------------------------------------------

// FNV-1a, so a given MAC always lands at the same angle across restarts.
function hashAngle(mac) {
  let h = 2166136261;
  for (let i = 0; i < mac.length; i++) {
    h ^= mac.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000 * Math.PI * 2;
}

function rssiRadius(rssi) {
  const t = Math.max(0, Math.min(1, (RSSI_STRONG - rssi) / (RSSI_STRONG - RSSI_WEAK)));
  return R_IN + t * (R_OUT - R_IN);
}

// ---- state ------------------------------------------------------------

const nodes = new Map();
let particles = [];
let total = 0;
let windowCount = 0;
let pps = 0;

const MAX_PARTICLES = 2600;
const NODE_TTL = 45000;

function touch(pkt) {
  let n = nodes.get(pkt.mac);
  if (!n) {
    n = {
      mac: pkt.mac,
      angle: hashAngle(pkt.mac),
      rssi: pkt.rssi,
      r: R_OUT,
      isAp: false,
      count: 0,
      seen: 0,
      born: performance.now(),
    };
    nodes.set(pkt.mac, n);
  }
  n.rssi = n.rssi * 0.85 + pkt.rssi * 0.15;   // RSSI wanders 3-5dB standing still
  n.count++;
  n.seen = performance.now();
  if (pkt.name === 'beacon') n.isAp = true;
  return n;
}

function spawn(pkt) {
  if (pkt.mac === '00:00:00:00:00:00') return;   // ACK/CTS carry no addr2
  const n = touch(pkt);
  if (particles.length >= MAX_PARTICLES) return;

  const beacon = pkt.name === 'beacon';
  const jitter = (Math.random() - 0.5) * 0.26;
  const a = n.angle + jitter;
  const r = n.r + (Math.random() - 0.5) * 16;

  particles.push({
    sx: CX + Math.cos(a) * r,
    sy: CY + Math.sin(a) * r,
    // A burst arrives inside one 50ms batch, so without a stagger every frame
    // in it flies in lockstep and the whole burst fuses into one solid rail.
    t: -Math.random() * 200,
    dur: 480 + Math.random() * 260,
    // log scale: a 1500 byte frame is not 100x more interesting than a 14 byte ack
    size: 0.9 + Math.log2(Math.max(pkt.len, 8)) * 0.34,
    rgb: C[pkt.cls] ?? C.unknown,
    // beacons are ~10/sec per AP forever and will drown everything else
    alpha: beacon ? 0.3 : 1,
  });
}

// ---- render -----------------------------------------------------------

let last = performance.now();

function frame(now) {
  const dt = Math.min(now - last, 64);
  last = now;

  // trail fade instead of a hard clear, so bursts leave a wake
  ctx.fillStyle = 'rgba(5, 7, 13, 0.15)';
  ctx.fillRect(0, 0, W, H);

  drawRings();

  // particles
  ctx.globalCompositeOperation = 'lighter';
  const alive = [];
  for (const p of particles) {
    p.t += dt;
    const k = p.t / p.dur;
    if (k >= 1) continue;
    if (k < 0) { alive.push(p); continue; }   // staggered, not yet launched
    const e = k * k * (3 - 2 * k);           // smoothstep: eases into the centre
    const x = p.sx + (CX - p.sx) * e;
    const y = p.sy + (CY - p.sy) * e;
    const fade = (1 - k * k) * p.alpha;
    const [r, g, b] = p.rgb;
    ctx.fillStyle = `rgba(${r},${g},${b},${fade})`;
    ctx.beginPath();
    ctx.arc(x, y, p.size, 0, 6.2832);
    ctx.fill();
    alive.push(p);
  }
  particles = alive;
  ctx.globalCompositeOperation = 'source-over';

  drawNodes(now);
  drawHub(now);

  requestAnimationFrame(frame);
}

function drawRings() {
  ctx.strokeStyle = 'rgba(120, 150, 190, 0.09)';
  ctx.fillStyle = 'rgba(120, 150, 190, 0.34)';
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.lineWidth = 1;
  for (const dbm of RINGS) {
    const r = rssiRadius(dbm);
    ctx.beginPath();
    ctx.arc(CX, CY, r, 0, 6.2832);
    ctx.stroke();
    ctx.fillText(`${dbm}dBm`, CX + 5, CY - r - 5);
  }
}

function drawNodes(now) {
  ctx.font = '10px ui-monospace, Menlo, monospace';
  for (const [mac, n] of nodes) {
    const idle = now - n.seen;
    if (idle > NODE_TTL) { nodes.delete(mac); continue; }

    const target = rssiRadius(n.rssi);
    n.r += (target - n.r) * 0.06;            // glide, do not snap

    const x = CX + Math.cos(n.angle) * n.r;
    const y = CY + Math.sin(n.angle) * n.r;
    const life = Math.max(0, 1 - idle / NODE_TTL);
    const appear = Math.min(1, (now - n.born) / 700);
    const a = life * appear;

    // faint tether back to the centre
    ctx.strokeStyle = `rgba(120, 150, 190, ${0.07 * a})`;
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(x, y);
    ctx.stroke();

    if (n.isAp) {
      ctx.strokeStyle = `rgba(232, 238, 247, ${0.55 * a})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, 6.2832);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 10.5, 0, 6.2832);
      ctx.strokeStyle = `rgba(232, 238, 247, ${0.18 * a})`;
      ctx.stroke();
    } else {
      ctx.fillStyle = `rgba(200, 216, 236, ${0.7 * a})`;
      ctx.beginPath();
      ctx.arc(x, y, 3.2, 0, 6.2832);
      ctx.fill();
    }

    const label = mac.slice(9);              // last three octets
    const right = Math.cos(n.angle) > 0;
    ctx.fillStyle = `rgba(200, 216, 236, ${0.5 * a})`;
    ctx.textAlign = right ? 'left' : 'right';
    ctx.fillText(label, x + (right ? 14 : -14), y + 3.5);
    ctx.textAlign = 'left';
  }
}

function drawHub(now) {
  const pulse = 1 + Math.sin(now / 620) * 0.06;
  const g = ctx.createRadialGradient(CX, CY, 0, CX, CY, 46 * pulse);
  g.addColorStop(0, 'rgba(232, 244, 255, 0.55)');
  g.addColorStop(0.35, 'rgba(120, 200, 235, 0.14)');
  g.addColorStop(1, 'rgba(120, 200, 235, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(CX, CY, 46 * pulse, 0, 6.2832);
  ctx.fill();

  ctx.fillStyle = 'rgba(240, 250, 255, 0.9)';
  ctx.beginPath();
  ctx.arc(CX, CY, 3.4, 0, 6.2832);
  ctx.fill();
}

requestAnimationFrame(frame);

// ---- hud --------------------------------------------------------------

const el = {
  pps: document.getElementById('pps'),
  devices: document.getElementById('devices'),
  total: document.getElementById('total'),
  status: document.getElementById('status'),
};

setInterval(() => {
  pps = windowCount;
  windowCount = 0;
  el.pps.textContent = pps;
  el.devices.textContent = nodes.size;
  el.total.textContent = total.toLocaleString();
}, 1000);

// ---- transport --------------------------------------------------------

let ws;
let retry = 0;

function connect() {
  ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => {
    retry = 0;
    el.status.textContent = 'live';
    el.status.className = 'ok';
  };

  ws.onmessage = (ev) => {
    const { pkts } = JSON.parse(ev.data);
    for (const p of pkts) {
      total++;
      windowCount++;
      spawn(p);
    }
  };

  ws.onclose = () => {
    el.status.textContent = 'disconnected, retrying';
    el.status.className = '';
    retry = Math.min(retry + 1, 6);
    setTimeout(connect, 400 * retry);
  };

  ws.onerror = () => ws.close();
}

connect();
