// A DualSense's adaptive triggers (Sony's PS5 controller, and the DualSense Edge), driven through WebHID while the
// game runs: the throttle (R2) and the brake (L2) push back, and shake, with what the car does.
//
// The Gamepad API reads the controller and plays the game's rumble on its motors (gamepad.ts), but has no word for
// the triggers' own motors.  Those take an effect each in the controller's output report, which Chrome and Edge let a
// page send once the player picked the controller in the browser's list (connectDualSense, from a click: the Controls
// sheet's), and on later visits without asking (navigator.hid.getDevices).  The report says which of its parts count
// (its first two bytes): this file sets the triggers' two bits and the motors' (the game's rumble, which the page
// plays itself on a controller open here: setRumble), so the lights and the sound stay the browser's and the system's.  A DualShock 4 has no motors in its triggers: it rumbles, and that is all it can.
//
// The report (Sony's, as the Linux kernel's hid-playstation.c and SDL's SDL_hidapi_ps5.c have it): 47 bytes, sent as
// report 0x02 on a cable; over Bluetooth as report 0x31 behind a sequence byte and a tag (0x10), padded to 77 bytes
// that end in a CRC-32 of 0xA2, the report id and the bytes before it.  Bytes 10 to 20 are R2's effect and 21 to 31
// L2's: a mode and ten parameters.  The modes used here are the two that take a strength for each tenth of the
// trigger's travel ("zones", 3 bits each: 0 to 7 for strengths 1 to 8, under a mask of the zones in use): 0x21 pushes
// back, 0x26 shakes at a frequency (Hz, its ninth parameter); 0x05 lets the trigger go.
//
// What the triggers do (triggerEffects) comes from the game's status table (runtime/web/status_web.c: "drive",
// "car_speed", "car_rpm", "car_gear"), the game's rumble levels and the triggers' own positions:
//   R2, the throttle  a light spring on the way down; held down, the engine's hum instead (faster and stronger as the
//                     revs climb, so a gear is felt running out); a kick when the gearbox shifts; a fine shake while
//                     the engine sits at the top of its revs (the highest it has reached in this car, once it has
//                     come down from there: the limiter, or an automatic's shift point), and while the wheels spin
//                     off the line
//   L2, the brake     a spring that stiffens with the car's speed; a judder while it is held down hard at speed,
//                     slower as the car slows
//   both              a shake with a crash (the game's strong rumble)
// The motors add the road to the game's rumble (roadrumble.ts, settings.ini road_rumble): the tyres under hard braking
// and in a fast corner, from the brake, the stick and the car's speed (the game's status has no word for the tyres'
// slip).  How strong all of it is, is the player's: settings.ini trigger_strength (Off, Light, Medium, Strong; Controls,
// Controller), and road_rumble turns the road's rumble off.
// A game built before those status words has only "drive": the springs alone.  Outside driving (menus, the pause, a
// hidden or unfocused page, the game's end) both triggers are let go.

import type { PadSnapshot } from './gamepad';
import { roadRumble, type Rumble } from './roadrumble';
export { roadRumble, type RoadInput, type Rumble } from './roadrumble';
import { PAD_AXIS_LT, PAD_AXIS_LX, PAD_AXIS_RT } from './proto';

/** a WebHID device, as much of it as this file uses (TypeScript's DOM types have none) */
interface HidDevice extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: readonly { outputReports?: readonly { reportId?: number }[] }[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
}
interface HidReportEvent extends Event { readonly reportId: number; readonly data: DataView }
interface HidConnectionEvent extends Event { readonly device: HidDevice }
interface Hid extends EventTarget {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(o: { filters: { vendorId: number; productId?: number }[] }): Promise<HidDevice[]>;
}
const hid = (): Hid | null => (globalThis.navigator as unknown as { hid?: Hid } | undefined)?.hid ?? null;

const SONY = 0x054c;
/** the controllers with adaptive triggers, by USB product id */
export const DUALSENSE_PRODUCTS: Readonly<Record<number, string>> = { 0x0ce6: 'DualSense', 0x0df2: 'DualSense Edge' };
const nameOf = (d: HidDevice): string | null => d.vendorId === SONY ? DUALSENSE_PRODUCTS[d.productId] ?? null : null;
/** whether a Gamepad.id is one of them (Chrome: "... Vendor: 054c Product: 0ce6)") */
export const isDualSense = (id: string) => /Vendor: 054c Product: (0ce6|0df2)\)/i.test(id);

// ---- the effects ---------------------------------------------------------------------------------------------------

/** a trigger's effect: let go; pushing back, a strength 0..8 for each tenth of its travel; shaking at hz, likewise */
export type TriggerEffect =
  | { kind: 'off' }
  | { kind: 'push'; zones: readonly number[] }
  | { kind: 'shake'; hz: number; zones: readonly number[] };
export const TRIGGER_OFF: TriggerEffect = { kind: 'off' };

/** an effect as the report's 11 bytes: the mode and its parameters */
export function triggerBytes(e: TriggerEffect): Uint8Array {
  const out = new Uint8Array(11);
  if (e.kind === 'off') { out[0] = 0x05; return out; }
  let active = 0, force = 0;
  for (let i = 0; i < 10; i++) {
    const s = Math.max(0, Math.min(8, Math.round(e.zones[i] ?? 0)));
    if (!s) continue;
    active |= 1 << i;
    force += (s - 1) * 2 ** (3 * i);          // 30 bits: past a 32-bit shift's sign
  }
  if (!active) { out[0] = 0x05; return out; }
  out[0] = e.kind === 'push' ? 0x21 : 0x26;
  out[1] = active & 0xff; out[2] = active >> 8;
  out[3] = force & 0xff; out[4] = (force >>> 8) & 0xff; out[5] = (force >>> 16) & 0xff; out[6] = Math.floor(force / 2 ** 24) & 0xff;
  if (e.kind === 'shake') out[9] = Math.max(1, Math.min(255, Math.round(e.hz)));
  return out;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
/** CRC-32 (zlib's) of the bytes */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The output report that sets both triggers and nothing else: its id and the bytes after it (what sendReport takes).
 *  bluetooth: report 0x31 with seq (0..15) and the CRC, else report 0x02. */
export function triggerReport(r2: TriggerEffect, l2: TriggerEffect, bluetooth: boolean, seq = 0, rumble?: Rumble): { id: number; data: Uint8Array } {
  const common = new Uint8Array(47);
  common[0] = 0x04 | 0x08;                    // what counts: R2's effect, L2's effect
  if (rumble) {
    common[0] |= 0x01 | 0x02;                 // and the two motors, as a DualShock 4's ("compatible vibration")
    common[2] = level(rumble.weak);           // the right motor: the small, fast one
    common[3] = level(rumble.strong);         // the left motor: the big, slow one
  }
  common.set(triggerBytes(r2), 10);
  common.set(triggerBytes(l2), 21);
  if (!bluetooth) return { id: 0x02, data: common };
  const data = new Uint8Array(77);
  data[0] = (seq & 0xf) << 4; data[1] = 0x10;
  data.set(common, 2);
  const sum = new Uint8Array(75);
  sum[0] = 0xa2; sum[1] = 0x31; sum.set(data.subarray(0, 73), 2);
  const c = crc32(sum);
  data[73] = c & 0xff; data[74] = (c >>> 8) & 0xff; data[75] = (c >>> 16) & 0xff; data[76] = c >>> 24;
  return { id: 0x31, data };
}

const level = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/** what the triggers' effects come from, each time they are worked out */
export interface TriggerInput {
  /** performance.now() */
  now: number;
  /** the game's "drive" status (0: not driving) and whether the page is visible and focused */
  drive: number; shown: boolean;
  /** the car's speed (m/s), its engine's rpm and its gear (0 reverse, 1 neutral, 2 first ..); undefined: a game that
   *  does not say */
  speed?: number; rpm?: number; gear?: number;
  /** the triggers, 0..1 */
  throttle: number; brake: number;
  /** the game's rumble on the strong motor, 0..1 */
  hit: number;
  /** how strong the effects are, 0..1 (STRENGTHS; undefined: 1) */
  scale?: number;
}

/** how strong the triggers are (settings.ini trigger_strength: Controls, Controller), and each one's share of the full
 *  strength; off: no effects, the controller still open for its rumble */
export type Strength = 'off' | 'light' | 'medium' | 'strong';
export const STRENGTHS: Readonly<Record<Strength, number>> = { off: 0, light: 0.45, medium: 0.7, strong: 1 };
const isStrength = (v: string): v is Strength => Object.hasOwn(STRENGTHS, v);
let strength: Strength = 'strong', road = true;
export function triggerStrength(): Strength { return strength; }
export function setTriggerStrength(v: Strength) { strength = v; }
/** the settings as settings.ini has them (shell.ts, each time it is read or written): trigger_strength, road_rumble */
export function setDualSenseSettings(s: { strength: string; road: boolean }) {
  strength = isStrength(s.strength) ? s.strength : 'strong';
  road = s.road;
}

/** from a zone on, one strength */
const from = (zone: number, s: number) => Array.from({ length: 10 }, (_, i) => i >= zone ? s : 0);
/** an effect at a share of its strength (never below 1: the effect stays) */
function scaled(e: TriggerEffect, k: number): TriggerEffect {
  if (k <= 0) return TRIGGER_OFF;
  if (e.kind === 'off' || k >= 1) return e;
  return { ...e, zones: e.zones.map(s => s ? Math.max(1, Math.round(s * k)) : 0) };
}

/**
 * The triggers' effects from the car's state, with what has to be remembered between two calls: the gear (a shift's
 * kick lasts KICK_MS), and the top of this car's revs.  The top is the highest rpm seen; it counts as known once the
 * engine came down a tenth from it (a shift) or stayed within 1 % of it for LIMIT_MS on the throttle (the limiter), so
 * the first run up through the revs does not shake all the way.  It is forgotten when the game stops saying the rpm,
 * and after FORGET_MS without driving (another race, perhaps another car).
 */
export class TriggerFeel {
  private gear = -1;
  private kickUntil = 0;
  private top = 0;
  private topKnown = false;
  private nearSince = 0;
  private idleSince = 0;
  private held = false;

  effects(i: TriggerInput): { r2: TriggerEffect; l2: TriggerEffect } {
    const { r2, l2 } = this.full(i), k = i.scale ?? 1;
    return { r2: scaled(r2, k), l2: scaled(l2, k) };
  }

  private full(i: TriggerInput): { r2: TriggerEffect; l2: TriggerEffect } {
    const driving = (i.drive & 3) !== 0 && i.shown;
    if (!driving) {
      if (!this.idleSince) this.idleSince = i.now;
      if (i.now - this.idleSince > FORGET_MS || i.rpm === undefined) { this.top = 0; this.topKnown = false; }
      this.gear = -1; this.kickUntil = 0; this.nearSince = 0; this.held = false;
      return { r2: TRIGGER_OFF, l2: TRIGGER_OFF };
    }
    this.idleSince = 0;
    const speed = Math.abs(i.speed ?? 0), rpm = i.rpm ?? 0, gear = i.gear ?? -1;

    // a shift between forward gears: the kick
    if (this.gear >= 2 && gear >= 2 && gear !== this.gear) this.kickUntil = i.now + KICK_MS;
    this.gear = gear;

    // the top of the revs
    if (rpm > this.top) { this.top = rpm; this.nearSince = i.now; }
    if (this.top >= MIN_TOP) {
      if (rpm < this.top * 0.9) this.topKnown = true;
      if (rpm >= this.top * 0.99 && i.throttle > 0.5) {
        if (!this.nearSince) this.nearSince = i.now;
        if (i.now - this.nearSince >= LIMIT_MS) this.topKnown = true;
      } else this.nearSince = 0;
    }
    const atTop = this.topKnown && rpm >= this.top * 0.97;
    // off the line: first gear, slow, the engine high in its revs
    const spin = gear === 2 && speed < 9 && this.top >= MIN_TOP && rpm > this.top * 0.8 && i.throttle > 0.7;

    let r2: TriggerEffect, l2: TriggerEffect;
    if (i.hit > 0.45) {
      const s = i.hit > 0.8 ? 8 : 6;
      return { r2: { kind: 'shake', hz: 22, zones: from(0, s) }, l2: { kind: 'shake', hz: 22, zones: from(0, s) } };
    }
    if (i.now < this.kickUntil) r2 = { kind: 'push', zones: from(1, 8) };
    else if (atTop && i.throttle > 0.3) r2 = { kind: 'shake', hz: 38, zones: from(3, 4) };
    else if (spin) r2 = { kind: 'shake', hz: 55, zones: from(4, 3) };
    else {
      // held down (from HELD_ON of its travel, until back at HELD_OFF), in a forward gear: the engine's hum in place
      // of the spring, HUM_HZ[0] at idle to HUM_HZ[1] at the top of the revs, strength 1 to 3
      this.held = i.throttle >= (this.held ? HELD_OFF : HELD_ON);
      if (this.held && i.rpm !== undefined && gear >= 2) {
        const f = Math.max(0, Math.min(1, rpm / Math.max(this.top, MIN_TOP)));
        r2 = { kind: 'shake', hz: HUM_HZ[0] + (HUM_HZ[1] - HUM_HZ[0]) * f, zones: from(4, 1 + Math.round(2 * f * f)) };
      } else r2 = { kind: 'push', zones: from(2, 2) };
    }

    // the brake: stiffer the faster the car goes (strength 2 standing, 7 from 55 m/s, about 200 km/h); held hard at
    // speed, a judder, 24 Hz at 55 m/s down to 10 as the car slows
    const firm = 2 + Math.round(5 * Math.min(1, speed / 55));
    if (i.brake > 0.75 && speed > 14 && gear !== 0)
      l2 = { kind: 'shake', hz: 10 + 14 * Math.min(1, speed / 55), zones: from(5, Math.min(8, firm + 1)) };
    else l2 = { kind: 'push', zones: from(1, gear === 0 ? 2 : firm) };
    return { r2, l2 };
  }
}
/** a shift's kick, the limiter's wait, how long a car's top revs are kept while not driving (ms); the least rpm that
 *  counts as a top (an engine that never left idle has none) */
const KICK_MS = 110, LIMIT_MS = 400, FORGET_MS = 20000, MIN_TOP = 4500;
/** the throttle counts as held down from HELD_ON of its travel until it is back at HELD_OFF; the hum's frequency at
 *  idle and at the top of the revs (Hz) */
const HELD_ON = 0.6, HELD_OFF = 0.45, HUM_HZ = [16, 46] as const;

// ---- a DualSense over Bluetooth as the game's gamepad ------------------------------------------------------------
// Over Bluetooth a DualSense starts with short reports (0x01) that Windows and Chrome read as a gamepad.  Its first
// output report (the triggers', or the rumble's) turns it to its full reports (0x31), which they do not read: the
// browser's gamepad goes still, or never shows (a player's DualSense on Windows, 2026-11-13: connected here, no
// controller in the game).  So one open here over Bluetooth is read from its own reports, either kind, as SDL's
// SDL_hidapi_ps5.c lays them out, and given to the game as a gamepad of the standard mapping (bluetoothPads:
// steampad.ts allPads puts it in the browser's list in place of the browser's own).  Over USB the browser reads it as
// it always did.

/** a DualSense's state as the standard mapping has it: the sticks -1..1 (+y down), the 18 buttons 0..1 */
export interface PadState { axes: [number, number, number, number]; buttons: number[] }

const stick = (v: number) => Math.max(-1, Math.min(1, (v - 127.5) / 127.5));
/** the D-pad's hat (0 up, clockwise in eighths, 8 and up none) -> up, down, left, right */
const hatDirs = (h: number): [boolean, boolean, boolean, boolean] =>
  h > 7 ? [false, false, false, false] : [h === 7 || h <= 1, h >= 3 && h <= 5, h >= 5 && h <= 7, h >= 1 && h <= 3];

/** A DualSense's input report (data without its id) -> its state: 0x31, Bluetooth's full one (a tag byte, then USB's
 *  0x01 layout: the sticks, the triggers, a counter, three bytes of buttons), or 0x01, Bluetooth's short one (the
 *  sticks, three bytes of buttons with a counter, the triggers).  Else null. */
export function readDualSense(reportId: number, d: DataView): PadState | null {
  let lx, ly, rx, ry, l2, r2, b0, b1, b2;
  if (reportId === 0x31 && d.byteLength >= 11) {
    [lx, ly, rx, ry, l2, r2] = [1, 2, 3, 4, 5, 6].map(i => d.getUint8(i));
    [b0, b1, b2] = [8, 9, 10].map(i => d.getUint8(i));
  } else if (reportId === 0x01 && d.byteLength >= 9) {
    [lx, ly, rx, ry, b0, b1, b2, l2, r2] = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => d.getUint8(i));
  } else return null;
  const [up, down, left, right] = hatDirs(b0 & 0x0f);
  const on = (x: boolean) => x ? 1 : 0;
  const lt = Math.max(l2 / 255, on((b1 & 0x04) !== 0) * 0.01), rt = Math.max(r2 / 255, on((b1 & 0x08) !== 0) * 0.01);
  return {
    axes: [stick(lx), stick(ly), stick(rx), stick(ry)],
    // cross, circle, square, triangle, L1, R1, L2, R2, Create, Options, L3, R3, up, down, left, right, PS, touchpad
    buttons: [on((b0 & 0x20) !== 0), on((b0 & 0x40) !== 0), on((b0 & 0x10) !== 0), on((b0 & 0x80) !== 0),
      on((b1 & 0x01) !== 0), on((b1 & 0x02) !== 0), lt, rt,
      on((b1 & 0x10) !== 0), on((b1 & 0x20) !== 0), on((b1 & 0x40) !== 0), on((b1 & 0x80) !== 0),
      on(up), on(down), on(left), on(right), on((b2 & 0x01) !== 0), on((b2 & 0x02) !== 0)],
  };
}

interface Button { pressed: boolean; touched: boolean; value: number }
/** the gamepads of these, after the browser's own and Valve's (steampad.ts: 16 and up) */
const BT_FIRST_INDEX = 24;
const freeIndex = () => {
  const used = new Set([...pads.values()].map(p => p.bt?.gp.index));
  let i = BT_FIRST_INDEX;
  while (used.has(i)) i++;
  return i;
};
function announce(type: 'gamepadconnected' | 'gamepaddisconnected', gp: Gamepad) {
  if (typeof dispatchEvent !== 'function') return;
  const e = new Event(type);
  Object.defineProperty(e, 'gamepad', { value: gp });
  dispatchEvent(e);
}

/** a DualSense over Bluetooth as a Gamepad: its id as Chrome writes one (isDualSense), connected from its first
 *  report; its rumble is this file's (gamepad.ts: a DualSense open here) */
class BtGamepad {
  readonly gp: Gamepad;
  connected = false;
  private buttons: Button[] = Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 }));
  private axes = [0, 0, 0, 0];
  constructor(dev: HidDevice, index: number) {
    const pid = dev.productId.toString(16).padStart(4, '0');
    this.gp = { id: `${dev.productName || 'DualSense Wireless Controller'} (STANDARD GAMEPAD Vendor: 054c Product: ${pid})`,
      index, mapping: 'standard', connected: false, timestamp: 0, axes: this.axes, buttons: this.buttons,
      vibrationActuator: null, hapticActuators: [] } as unknown as Gamepad;
  }
  show(s: PadState) {
    for (let i = 0; i < this.buttons.length; i++) {
      const b = this.buttons[i], v = s.buttons[i] ?? 0;
      b.value = v; b.pressed = v >= 0.5 || (i !== 6 && i !== 7 && v > 0); b.touched = v > 0;
    }
    for (let i = 0; i < 4; i++) this.axes[i] = s.axes[i];
    (this.gp as unknown as { timestamp: number }).timestamp = performance.now();
    if (!this.connected) {
      this.connected = true;
      (this.gp as unknown as { connected: boolean }).connected = true;
      log(`[pad] ${this.gp.id}: over Bluetooth, read here as controller ${this.gp.index}`);
      announce('gamepadconnected', this.gp);
    }
  }
  drop() {
    if (!this.connected) return;
    this.connected = false;
    (this.gp as unknown as { connected: boolean }).connected = false;
    announce('gamepaddisconnected', this.gp);
  }
}

/** the DualSenses over Bluetooth read here (steampad.ts allPads: in place of the browser's own) */
export function bluetoothPads(): Gamepad[] {
  const out: Gamepad[] = [];
  for (const p of pads.values()) if (p.bt?.connected) out.push(p.bt.gp);
  return out;
}

// ---- the controllers -----------------------------------------------------------------------------------------------

let log: (s: string) => void = () => {};

class Pad {
  readonly name: string;
  private bluetooth: boolean;
  private seq = 0;
  private sent = '';
  private sentAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private failed = false;
  /** the game's rumble, which this controller plays from the report too (the page's own, not the browser's) */
  rumble: Rumble = { strong: 0, weak: 0 };
  /** the road's rumble (roadRumble), played with the game's: the stronger of the two on each motor */
  road: Rumble = { strong: 0, weak: 0 };

  /** over Bluetooth: the controller as the game's gamepad, read from its reports here (BtGamepad) */
  bt: BtGamepad | null = null;

  constructor(readonly dev: HidDevice) {
    this.name = nameOf(dev) ?? 'DualSense';
    this.bluetooth = dev.collections.some(c => c.outputReports?.some(r => r.reportId === 0x31));
  }
  get transport() { return this.bluetooth ? 'Bluetooth' : 'USB'; }

  /** over Bluetooth the controller's full reports are 0x31 too (a browser that lists no output reports); there, its
   *  reports are the game's gamepad */
  onReport = (e: Event) => {
    const r = e as HidReportEvent;
    if (r.reportId === 0x31 && !this.bluetooth) { this.bluetooth = true; this.sent = ''; }
    if (!this.bluetooth) return;
    this.bt ??= new BtGamepad(this.dev, freeIndex());
    const st = readDualSense(r.reportId, r.data);
    if (st) this.bt.show(st);
  };

  /** the two effects, sent when they change (at most every SEND_MS, but a new one after QUIET_MS at once), and again
   *  every RESEND_MS: a controller that slept and woke has none */
  set(r2: TriggerEffect, l2: TriggerEffect, force = false) {
    if (!this.dev.opened) return;
    const rumble = { strong: Math.max(this.rumble.strong, this.road.strong), weak: Math.max(this.rumble.weak, this.road.weak) };
    const key = `${triggerBytes(r2).join()}|${triggerBytes(l2).join()}|${level(rumble.strong)},${level(rumble.weak)}`, now = performance.now(), since = now - this.sentAt;
    if (!force && (key === this.sent ? since < RESEND_MS : since < SEND_MS)) return;
    this.sent = key; this.sentAt = now;
    const { id, data } = triggerReport(r2, l2, this.bluetooth, this.seq = (this.seq + 1) & 0xf, rumble);
    this.queue = this.queue.then(() => this.dev.sendReport(id, data as BufferSource)).catch(err => {
      if (!this.failed) { this.failed = true; log(`[pad] ${this.name}: its triggers cannot be set: ${(err as Error)?.message ?? err}`); }
    });
  }

  /** the triggers let go and the motors still */
  quiet() { this.rumble = { strong: 0, weak: 0 }; this.road = { strong: 0, weak: 0 }; this.set(TRIGGER_OFF, TRIGGER_OFF, true); }

  close() {
    this.quiet();
    this.bt?.drop();
    this.dev.removeEventListener('inputreport', this.onReport);
    this.queue = this.queue.then(() => this.dev.opened ? this.dev.close() : undefined).catch(() => {});
  }
}
/** the least time between two reports while the effects move, and a standing one's repeat (ms) */
const SEND_MS = 25, RESEND_MS = 2000;

const pads = new Map<HidDevice, Pad>();
let users = 0;

async function add(dev: HidDevice) {
  if (!nameOf(dev) || pads.has(dev) || !users) return;
  const p = new Pad(dev);
  pads.set(dev, p);
  try { if (!dev.opened) await dev.open(); }
  catch (err) {
    log(`[pad] ${p.name}: cannot open it for its triggers: ${(err as Error)?.message ?? err}`);
    pads.delete(dev);
    return;
  }
  if (pads.get(dev) !== p) return;
  dev.addEventListener('inputreport', p.onReport);
  log(`[pad] ${p.name}: adaptive triggers on (${p.transport})`);
}
function remove(dev: HidDevice) {
  const p = pads.get(dev);
  if (!p) return;
  pads.delete(dev);
  p.close();
}
const onHidConnect = (e: Event) => void add((e as HidConnectionEvent).device);
const onHidDisconnect = (e: Event) => {
  const dev = (e as HidConnectionEvent).device;
  pads.get(dev)?.bt?.drop();
  pads.delete(dev);
};
/** the tab closing: the triggers let go (they would keep their last effect until the controller sleeps) */
const onPageHide = () => { for (const p of pads.values()) p.quiet(); };

/** While the game runs (the PadPoller's, until the function it returns is called): the controllers picked before
 *  opened, those plugged in or picked later too.  logf: the page's log. */
export function useDualSense(logf: (s: string) => void): () => void {
  const h = hid();
  if (!h) return () => {};
  log = logf;
  if (users++ === 0) {
    h.addEventListener('connect', onHidConnect);
    h.addEventListener('disconnect', onHidDisconnect);
    addEventListener('pagehide', onPageHide);
    h.getDevices().then(ds => { for (const d of ds) void add(d); }, err => log(`[pad] WebHID: ${(err as Error)?.message ?? err}`));
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--users > 0) return;
    h.removeEventListener('connect', onHidConnect);
    h.removeEventListener('disconnect', onHidDisconnect);
    removeEventListener('pagehide', onPageHide);
    for (const d of [...pads.keys()]) remove(d);
  };
}

/** whether any is open (the poller reads the game's status only then) */
export const dualSenseOpen = () => pads.size > 0;

/** The game's rumble for every controller open, sent with the triggers' next report (setTriggers).  The page plays a
 *  DualSense's rumble itself once the controller is open here: Chrome's own (vibrationActuator) stays silent on some
 *  of them while a page holds the controller through WebHID. */
export function setRumble(strong: number, weak: number) {
  for (const p of pads.values()) p.rumble = { strong, weak };
}

/** both triggers' effects onto every controller open */
export function setTriggers(r2: TriggerEffect, l2: TriggerEffect) {
  for (const p of pads.values()) p.set(r2, l2);
}

/**
 * The poller's share: every time the controller is read, the effects for the car's state onto the DualSenses open,
 * while one of them drives the game's pad (else they are let go).  status: the game's status table (null: not there
 * yet, or being written: the last one read stays).
 */
export class TriggerDriver {
  private feel = new TriggerFeel();
  private last: ReadonlyMap<string, number> | null = null;
  private readAt = 0;

  constructor(private status: () => ReadonlyMap<string, number> | null) {}

  update(driverId: string | null, s: PadSnapshot, hit: number) {
    if (!pads.size) return;
    const now = performance.now();
    if (now - this.readAt >= STATUS_MS) { this.readAt = now; this.last = this.status() ?? this.last; }
    const st = this.last;
    const shown = typeof document === 'undefined' || (document.visibilityState === 'visible' && document.hasFocus());
    const mine = !!driverId && isDualSense(driverId);
    const drive = mine ? st?.get('drive') ?? 0 : 0, scale = STRENGTHS[strength];
    const speed = st?.get('car_speed'), gear = st?.get('car_gear'), brake = s.axes[PAD_AXIS_LT] ?? 0;
    const { r2, l2 } = this.feel.effects({
      now, drive, shown, speed, rpm: st?.get('car_rpm'), gear,
      throttle: s.axes[PAD_AXIS_RT] ?? 0, brake, hit, scale,
    });
    // the road's rumble: its own switch (road_rumble), as strong as the triggers (full with them off)
    const r = road ? roadRumble({ driving: (drive & 3) !== 0 && shown, speed, gear, brake, steer: s.axes[PAD_AXIS_LX] ?? 0,
      scale: strength === 'off' ? 1 : scale }) : { strong: 0, weak: 0 };
    for (const p of pads.values()) p.road = r;
    setTriggers(r2, l2);
  }

  /** the game ended: the triggers let go */
  stop() { for (const p of pads.values()) p.quiet(); }
}
/** how often the game's status is read for the triggers (ms) */
const STATUS_MS = 15;

/** whether this browser can set them (WebHID: Chrome, Edge and Opera on a computer) */
export const dualSensePossible = () => !!hid();

const FILTERS = Object.keys(DUALSENSE_PRODUCTS).map(p => ({ vendorId: SONY, productId: +p }));

/** The browser's list of these controllers to pick from (only from a click: Chrome asks for one).  The one picked
 *  works at once while a game runs, else from the next Play, and on later visits without asking.  Resolves to the
 *  names of those picked (none: the list closed). */
export async function connectDualSense(): Promise<string[]> {
  const h = hid();
  if (!h) return [];
  const got = await h.requestDevice({ filters: FILTERS });
  for (const d of got) void add(d);
  return [...new Set(got.map(nameOf).filter((n): n is string => !!n))];
}

/** the names of these controllers picked in this browser before (they open on Play) */
export async function dualSensePicked(): Promise<string[]> {
  const h = hid();
  if (!h) return [];
  try { return [...new Set((await h.getDevices()).map(nameOf).filter((n): n is string => !!n))]; }
  catch { return []; }
}
