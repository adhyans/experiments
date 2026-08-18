// 802.11 frame decoding.
//
// Type and subtype live in the first byte of every frame's Frame Control
// field, which is transmitted unencrypted by design -- radios need it to
// arbitrate the medium. Everything past the header is WPA2/WPA3 ciphertext
// and is never read.

const MGMT = {
  0: 'assoc-req', 1: 'assoc-resp', 2: 'reassoc-req', 3: 'reassoc-resp',
  4: 'probe-req', 5: 'probe-resp', 8: 'beacon', 9: 'atim',
  10: 'disassoc', 11: 'auth', 12: 'deauth', 13: 'action',
};

const CTRL = {
  7: 'wrapper', 8: 'block-ack-req', 9: 'block-ack', 10: 'ps-poll',
  11: 'rts', 12: 'cts', 13: 'ack', 14: 'cf-end',
};

const DATA = {
  0: 'data', 1: 'data+cf-ack', 4: 'null', 8: 'qos-data',
  9: 'qos-data+cf-ack', 12: 'qos-null',
};

const CLASSES = ['mgmt', 'ctrl', 'data'];

export function decode(type, subtype) {
  const cls = CLASSES[type] ?? 'unknown';
  const name =
    type === 0 ? MGMT[subtype] :
    type === 1 ? CTRL[subtype] :
    type === 2 ? DATA[subtype] : undefined;
  return { cls, name: name ?? `${cls}-${subtype}` };
}

// One line of firmware output:  rssi,type,subtype,len,MAC,channel
// e.g.  -48,2,8,1204,F0189874190C,6
// Lines starting with # are firmware banners. Serial noise on connect is
// common and must not throw.
export function parseLine(line) {
  if (!line) return null;
  const s = line.trim();
  if (!s || s[0] === '#') return null;

  const f = s.split(',');
  if (f.length < 6) return null;

  const [rssi, type, subtype, len, mac, channel] = f;
  if (!/^[0-9A-Fa-f]{12}$/.test(mac)) return null;

  const n = [rssi, type, subtype, len, channel].map(Number);
  if (n.some((v) => !Number.isFinite(v))) return null;

  const { cls, name } = decode(n[1], n[2]);
  return {
    rssi: n[0],
    cls,
    name,
    len: n[3],
    mac: mac.toUpperCase().match(/.{2}/g).join(':'),
    ch: n[4],
  };
}
