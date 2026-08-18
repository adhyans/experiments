// node --test decode.test.js
//
// Guards the firmware -> bridge contract. A silent mismatch here renders as
// an empty screen with no error anywhere, which is miserable to debug with a
// board on the desk, so it is worth pinning down without one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLine, decode } from './decode.js';

test('parses a QoS data frame', () => {
  const p = parseLine('-48,2,8,1204,F0189874190C,6');
  assert.deepEqual(p, {
    rssi: -48, cls: 'data', name: 'qos-data',
    len: 1204, mac: 'F0:18:98:74:19:0C', ch: 6,
  });
});

test('parses a beacon', () => {
  const p = parseLine('-71,0,8,289,E89F805C22AB,11');
  assert.equal(p.cls, 'mgmt');
  assert.equal(p.name, 'beacon');
  assert.equal(p.ch, 11);
});

test('parses an ack, which the firmware zero-fills (no addr2 in the frame)', () => {
  const p = parseLine('-52,1,13,14,000000000000,6');
  assert.equal(p.cls, 'ctrl');
  assert.equal(p.name, 'ack');
  assert.equal(p.mac, '00:00:00:00:00:00');   // renderer drops these
});

test('unknown subtypes degrade to a labelled class, never to null', () => {
  assert.equal(decode(0, 6).name, 'mgmt-6');
  assert.equal(decode(1, 3).name, 'ctrl-3');
  assert.equal(decode(3, 0).cls, 'unknown');
});

test('rejects banners, blank lines, and serial garbage on connect', () => {
  for (const junk of [
    '', '   ', null,
    '# wifi-sniffer ready',
    '# rssi,type,subtype,len,mac,channel',
    'ets Jun  8 2016 00:22:57',           // ESP32 bootloader chatter
    'rst:0x1 (POWERON_RESET),boot:0x13',
    '-48,2,8,1204',                        // truncated mid-write
    '-48,2,8,1204,NOTAMAC,6',
    '-48,2,8,1204,F018987419,6',           // 10 hex chars, not 12
    'x,y,z,w,F0189874190C,6',
  ]) {
    assert.equal(parseLine(junk), null, `should reject: ${JSON.stringify(junk)}`);
  }
});

test('tolerates CRLF and lowercase hex', () => {
  const p = parseLine('-63,2,0,540,b827eb039a71,1\r');
  assert.equal(p.mac, 'B8:27:EB:03:9A:71');
  assert.equal(p.rssi, -63);
});
