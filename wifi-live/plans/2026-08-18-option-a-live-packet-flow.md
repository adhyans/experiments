# wifi-live, Option A: live packet flow

Executed 2026-08-16 to 2026-08-18. Status: **software complete and verified,
hardware blocked on USB enumeration.**

## Where this came from

The question was whether a phone camera could see, in real time, the packets
travelling between a device and its router. It cannot, and the reason is worth
recording because it shaped everything after it.

WiFi is light, just at the wrong end of the spectrum. 2.4 GHz is a 12.5 cm
wavelength against 400 to 700 nm for visible light. Two independent walls:

- **Energy.** A camera sensor is silicon photodiodes needing ~1.1 eV to lift an
  electron across the bandgap. A 2.4 GHz photon carries about 10 microelectronvolts,
  roughly 100,000x too little. Not a weak signal that longer exposure could rescue.
  The sensor cannot respond to that quantum at all.
- **Resolution.** Imaging resolution scales with aperture over wavelength. A phone
  lens is ~4 mm, which at 12.5 cm is a thirtieth of a wavelength. That is a single
  point sensor, not a camera.

The boundary of "a phone camera can see invisible light" sits near 1 micron, which
is why pointing a phone at an IR remote (940 nm) does work. WiFi is 100,000x past it.

That ruled out the direct approach and left four indirect ones.

## The four options

| | Approach | Shows | Hardware |
|---|---|---|---|
| **A** | ESP32 promiscuous sniffer to browser | Live traffic, per frame | 1 board |
| **B** | ESP32 CSI waterfall | Multipath structure of the room; reacts to motion | Same board |
| **C** | Mesh of ESP32s, interpolated | A true live spatial field | 6 to 12 boards |
| **D** | KrakenSDR direction finding | Angle of arrival, a bearing to the router | ~$500 |

**A was chosen** as closest to the original question: it literally shows the frames
going to and from the router, as they happen.

### The constraint that eliminated the obvious idea

The first instinct was light painting: the *Immaterials* project (Arnall, Knutsen,
Martinussen, 2011) walked a 4 m LED rod through Oslo and long-exposed the result,
producing photographs of the WiFi field draped through streets. Beautiful, and the
right answer to "show me the field".

It does not generalise to a live feed. Light painting works because a single sensor
is **moved through space** while the camera integrates; motion is doing the spatial
sampling. A device sitting still on a desk samples exactly one point, and no software
recovers space from that. So a stationary device cannot produce a live spatial map.
What it can do instead is the time dimension: traffic as it happens. Hence A.

## Architecture

```
ESP32 (promiscuous)  --USB serial CSV-->  Node bridge  --WebSocket-->  Canvas
```

### Decisions and why

**USB serial, not WiFi, for the uplink.** The ESP32 streaming its own output over the
channel it is sniffing creates feedback and costs frames. The cable is boring and correct.

**Ring buffer in the firmware.** The promiscuous callback runs inside the WiFi task.
Calling `Serial.print()` there stalls that task, drops frames, and eventually panics.
The callback writes to a lock-free SPSC ring; `loop()` does the slow I/O.

**Batched on a 50 ms tick.** A busy 2.4 GHz channel produces several thousand frames
per second. One WebSocket message per frame buries the renderer.

**Headers only.** Payloads are WPA2/WPA3 ciphertext and are never touched. Only the
802.11 header is decoded, which is transmitted in the clear by design because radios
need it to arbitrate the medium. The result shows flow, not content.

**A simulator, built first.** Synthetic traffic with the real shape (beacons at 10 Hz
per AP, bursty QoS data, a haze of ACKs) so the entire renderer could be built and
tuned during the days the board was in transit. This paid off directly: every visual
decision below was made and verified before hardware existed.

### Visual encoding

Centre is the board. Every particle is one frame that actually arrived at the antenna.

- **Radius** from RSSI, strong at the centre. Note this is *signal strength*, not
  distance: walls, bodies, and multipath push a device outward without it moving.
- **Angle** from an FNV-1a hash of the MAC, so a device lands in the same place across
  restarts.
- **Colour** by frame class; **size** as `0.9 + log2(len) x 0.34`, because a 1500-byte
  frame is not 100x more interesting than a 14-byte ACK.
- **Beacons dimmed** to 0.3 alpha. Every AP emits one every 102.4 ms forever and at
  full brightness they drown everything else.
- **Additive blending** with a trail fade rather than a hard clear, so dense bursts glow
  hotter for free and leave a wake.

## What verification caught

Each of these was invisible in the source and only appeared under a real check.

| Check | Found |
|---|---|
| Screenshot the renderer | Burst frames spawned on the same tick at the same angle and fused into a solid rail. Fixed with a random per-particle launch delay. |
| `arduino-cli compile --warnings all` | `dropped++` on a `volatile` is deprecated in C++20; `%u` against a `uint32_t`. Both would have become errors on a future core. |
| Reading the compile output critically | The drop counter was incremented and never read. A ring overflow would have looked *identical* to a quiet channel. Now reported as `# dropped N`. |
| Server-side viewer count | The browser had never connected. HTTP 200 only proves the page was served. |
| Reading the bridge log | A `\r`-rewritten status line interleaved with `console.log` and silently ate every connect/disconnect message, making "nobody connected" indistinguishable from "it scrolled past". |

The general lesson: **HTTP 200 is not a connection, and a silent failure that resembles
a quiet input is the expensive kind.** Both the firmware and the bridge now report
their own starvation explicitly.

## Verified state

- Firmware compiles for `esp32:esp32:esp32` with `--warnings all`, 0 warnings.
  877,068 bytes flash (66% of 1.31 MB), 51,512 bytes static RAM (15%).
- Bridge decode contract 6/6, covering ESP32 bootloader chatter on connect,
  truncated mid-write lines, and control frames with no addr2.
- Viewer ran ~10 minutes against live WebSocket traffic with a real browser attached,
  ~230 frames/sec sustained, 129,861 frames total.
- Toolchain trimmed 7.3 GB to 1.6 GB, verified safe by a clean rebuild producing
  byte-identical output.

## Open

**Hardware blocker.** The board arrived and does not enumerate on USB at all.
`ioreg -p IOUSB` lists no new device, which rules out a driver problem, because a
missing driver still shows the device with vendor and product IDs. Diagnostic path:
red power LED lit means a charge-only cable (most likely by far); LED dark means no
power at all. Then a known-good data cable, then direct into the machine rather than
a hub, then the second board.

**Channel.** The development machine is joined to 5 GHz channel 157, which the ESP32
cannot see at all. `CHANNEL` must be set to the router's 2.4 GHz channel, or
`CHANNEL_HOP` set true to sweep 1 to 13.

**MAC vendor lookup, recommended next.** The first three octets are an IEEE OUI, so an
offline table turns `8E:44:2D` into `Apple`. Held deliberately until real traffic
flows: the simulator emits six fabricated MACs, so building it now would be testing
against its own fixtures. With 30-odd real transmitters on screen it stops being
optional.

**Option B is the natural follow-on.** CSI needs no extra hardware and the firmware
has ample flash headroom.
