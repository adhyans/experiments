// wifi-sniffer -- ESP32 802.11 promiscuous monitor
//
// Streams one CSV line per received frame over USB serial:
//   rssi,type,subtype,len,transmitterMAC,channel
//
// Payloads are WPA2/WPA3 encrypted and are never touched. Only the
// unencrypted 802.11 header (which is transmitted in the clear by design,
// because radios need it to arbitrate the medium) is read.
//
// Build: Arduino IDE, board "ESP32 Dev Module", or `arduino-cli` / PlatformIO.

#include <WiFi.h>
#include <esp_wifi.h>

// ---- config -----------------------------------------------------------

#define CHANNEL      6      // your router's channel (WiFi analyzer app will tell you)
#define CHANNEL_HOP  false  // true = sweep 1..13, see every network, lose per-channel continuity
#define HOP_MS       250
#define BAUD         921600

// ---- ring buffer ------------------------------------------------------
// The promiscuous callback runs inside the WiFi task. Doing Serial.print()
// in there stalls that task, drops frames, and eventually panics. So the
// callback only writes to a lock-free single-producer/single-consumer ring
// and loop() does the slow I/O.

#define RB_SIZE 512

struct Pkt {
  int8_t   rssi;
  uint8_t  type;
  uint8_t  subtype;
  uint8_t  channel;
  uint16_t len;
  uint8_t  mac[6];
};

static Pkt rb[RB_SIZE];
static volatile uint16_t head = 0, tail = 0;
static volatile uint32_t dropped = 0;

// ---- sniffer ----------------------------------------------------------

void sniff(void *buf, wifi_promiscuous_pkt_type_t t) {
  const wifi_promiscuous_pkt_t *p = (wifi_promiscuous_pkt_t *)buf;
  const uint8_t *f = p->payload;

  uint16_t next = (head + 1) % RB_SIZE;
  // ++ on a volatile is deprecated in C++20; the explicit read-modify-write is
  // equivalent here because only this task ever writes `dropped`.
  if (next == tail) { dropped = dropped + 1; return; }   // full: never block the WiFi task

  rb[head].rssi    = p->rx_ctrl.rssi;
  rb[head].type    = (f[0] >> 2) & 0x03;     // 0=mgmt 1=ctrl 2=data
  rb[head].subtype = (f[0] >> 4) & 0x0F;
  rb[head].channel = p->rx_ctrl.channel;
  rb[head].len     = p->rx_ctrl.sig_len;

  // addr2 is the transmitter address. Control frames are short and some
  // (ACK, CTS) have no addr2 at all -- guard on length before reading it.
  if (p->rx_ctrl.sig_len >= 16) {
    memcpy(rb[head].mac, f + 10, 6);
  } else {
    memset(rb[head].mac, 0, 6);
  }

  head = next;
}

// ---- setup / loop -----------------------------------------------------

static uint8_t  curChannel = CHANNEL;
static uint32_t lastHop = 0;
static uint32_t lastReport = 0;
static uint32_t reported = 0;

void setup() {
  Serial.begin(BAUD);
  delay(200);

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();                         // never associate, just listen

  wifi_promiscuous_filter_t filter = {
    .filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT |
                   WIFI_PROMIS_FILTER_MASK_DATA |
                   WIFI_PROMIS_FILTER_MASK_CTRL
  };
  esp_wifi_set_promiscuous_filter(&filter);
  esp_wifi_set_promiscuous_rx_cb(&sniff);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(curChannel, WIFI_SECOND_CHAN_NONE);

  Serial.println("# wifi-sniffer ready");
  Serial.println("# rssi,type,subtype,len,mac,channel");
}

void loop() {
  while (tail != head) {
    const Pkt &p = rb[tail];
    Serial.printf("%d,%u,%u,%u,%02X%02X%02X%02X%02X%02X,%u\n",
                  p.rssi, p.type, p.subtype, p.len,
                  p.mac[0], p.mac[1], p.mac[2], p.mac[3], p.mac[4], p.mac[5],
                  p.channel);
    tail = (tail + 1) % RB_SIZE;
  }

  // Surface drops. A silent overflow looks identical to a quiet channel, so
  // without this you cannot tell "nothing is transmitting" from "the serial
  // link cannot keep up". If this climbs, raise BAUD or RB_SIZE.
  if (millis() - lastReport > 5000) {
    lastReport = millis();
    uint32_t d = dropped;
    if (d != reported) {
      Serial.printf("# dropped %lu\n", (unsigned long)(d - reported));
      reported = d;
    }
  }

  if (CHANNEL_HOP && millis() - lastHop > HOP_MS) {
    lastHop = millis();
    curChannel = (curChannel % 13) + 1;
    esp_wifi_set_channel(curChannel, WIFI_SECOND_CHAN_NONE);
  }
}
