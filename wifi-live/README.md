# wifi-live

Live visualisation of 802.11 traffic in the air around you. An ESP32 sits on the
table in promiscuous mode, hears every frame on a channel, and streams the
headers to a browser. Each frame becomes a particle flying inward to the centre,
because that is what physically happened: a burst of 2.4GHz left some device and
arrived at your antenna.

Centre of the screen is your board. Distance from centre is signal strength.
Angle is a stable hash of the transmitter's MAC, so a given device always lands
in the same place.

Runs today with no hardware: `npm run sim`.

## What you need to buy

Two things. No soldering.

| Item | Spec | Approx |
|---|---|---|
| ESP32 dev board | ESP32-WROOM-32, sold as "ESP32 DevKit V1" or "NodeMCU-32S", 30 or 38 pin | Rs 400 to 700 |
| USB data cable | micro-USB for most DevKit V1 boards. Must be a **data** cable, not charge-only | Rs 100 to 200 |

India: [Robu.in](https://robu.in), [Robocraze](https://robocraze.com),
[Quartz Components](https://quartzcomponents.com), or Amazon.in. Elsewhere:
AliExpress, Adafruit, SparkFun, DigiKey.

Notes before you order:

- **Prefer the CP2102 variant over CH340.** Both work, CP2102 tends to need less
  driver wrangling on macOS. If the serial port never appears after plugging in,
  install the driver for your board's USB-UART chip (Silicon Labs CP210x VCP, or
  WCH CH34x).
- **Buy two or three.** They are Rs 500 each, DOA units happen, and the mesh
  version of this project (live spatial heatmap) needs six to twelve of them.
- **Get the classic ESP32-WROOM-32**, not an ESP8266 and not a C2. The WROOM-32
  has the most reference code for both promiscuous mode and CSI, so the same
  board carries forward to the CSI waterfall build.
- Many boards ship without a cable. Check the listing.

## Layout

```
firmware/wifi-sniffer/   ESP32 sketch, CSV over USB serial
bridge/                  serial -> WebSocket, plus static host for the viewer
web/                     canvas renderer
```

## Run without hardware

```bash
cd bridge
npm install
npm run sim
open http://localhost:8080
```

Synthetic traffic with the same shape as the real thing: beacons at a steady
10Hz per AP, bursty QoS data from clients, a haze of ACKs.

## Run with the board

**1. Find your router's channel.** Option-click the WiFi menu on macOS, or
`sudo wdutil info`, or any WiFi analyzer app on your phone.

**2. Set it in the sketch.** `firmware/wifi-sniffer/wifi-sniffer.ino`:

```c
#define CHANNEL      6
#define CHANNEL_HOP  false   // true = sweep 1..13, see every network nearby
```

**3. Flash.** `arduino-cli` is already installed locally at `.tools/` and the
ESP32 core (esp32:esp32 3.3.11) is set up, so this is just:

```bash
cd wifi-live
export PATH="$PWD/.tools:$PATH"

arduino-cli compile --fqbn esp32:esp32:esp32 --warnings all firmware/wifi-sniffer
arduino-cli board list                      # find the port
arduino-cli upload -p /dev/cu.usbserial-0001 --fqbn esp32:esp32:esp32 firmware/wifi-sniffer
```

`esp32:esp32` is the generic "ESP32 Dev Module" target and is correct for any
ESP32-WROOM-32 board, 30-pin or 38-pin.

Compile is verified: 0 warnings, 877,068 bytes flash (66% of 1.31MB), 51,512
bytes static RAM (15%). Plenty of headroom for the CSI build later.

If the board does not appear in `arduino-cli board list`, in order of
likelihood: charge-only USB cable, missing USB-serial driver (Silicon Labs
CP210x VCP or WCH CH34x depending on the chip), or you need to hold BOOT while
plugging in.

**Note on the toolchain.** `esp32:esp32` installs 7.3GB by default, most of it
the RISC-V compiler and per-variant libraries for chips we do not use. It has
been trimmed to 1.6GB: the Xtensa toolchain, `esp32-libs`, and `esptool_py`,
which is everything a WROOM-32 needs. Verified with a clean rebuild after the
trim, byte-identical output. If you ever target an ESP32-C3, S3, or C6, run
`arduino-cli core install esp32:esp32 --overwrite` to pull the rest back.

**4. Run the bridge.**

```bash
cd bridge
npm start                          # auto-detects the port
npm start -- --port /dev/cu.usbserial-0001
npm run ports                      # if auto-detect picks the wrong one
```

## Design notes

**Why USB serial and not WiFi.** The ESP32 streaming its own output over the
channel it is sniffing creates feedback and costs you frames. The cable is
boring and correct.

**Why a ring buffer in the firmware.** The promiscuous callback runs inside the
WiFi task. Calling `Serial.print()` there stalls that task, drops frames, and
eventually panics. The callback only writes to a lock-free SPSC ring; `loop()`
does the slow I/O.

**Why frames are batched.** A busy 2.4GHz channel produces several thousand
frames per second. One WebSocket message per frame buries the renderer, so the
bridge batches on a 50ms tick.

**Why bursts are staggered in the renderer.** A burst arrives inside one batch,
so without a random launch delay every frame in it flies in lockstep and the
burst fuses into one solid rail instead of reading as individual frames.

**Beacons are dimmed.** Every AP in range emits one roughly every 102.4ms
forever. At full brightness they drown out the traffic you actually care about.

**Drops are reported, not swallowed.** If the ring buffer overflows the firmware
emits `# dropped N` every 5s and the bridge logs it. This matters because a
silent overflow looks exactly like a quiet channel: few particles on screen,
no error anywhere. If you see drops climbing, raise `BAUD` or `RB_SIZE`.

## What you are and are not seeing

Payloads are WPA2/WPA3 encrypted and are never read. The only thing decoded is
the 802.11 header, which is transmitted in the clear by design because radios
need it to arbitrate the medium: transmitter MAC, frame type, length, RSSI.

So this shows you flow, not content. Who is talking, how much, how strong, and
when. That is the interesting part anyway.

A note on what the picture means: radius is signal strength, not distance. They
correlate, but walls, bodies, and multipath all push a device outward without it
having moved. A device that suddenly drifts out is usually someone walking
between it and your board.

## Tests

```bash
cd bridge
node --test decode.test.js
```

Covers the firmware-to-bridge CSV contract, including bootloader chatter on
connect, truncated lines, and frames with no addr2. A mismatch there renders as
an empty screen with no error anywhere, which is miserable to debug with a board
on the desk.
