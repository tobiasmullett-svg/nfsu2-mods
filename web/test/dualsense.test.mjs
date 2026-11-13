// A DualSense's adaptive triggers (web/src/input/dualsense.ts): the effects as the controller's output report on a
// cable and over Bluetooth, and what the triggers do with the car's state.
//   node --test web/test/dualsense.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = async (f) => import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({
  entryPoints: [path.join(ROOT, f)], bundle: true, format: 'esm', write: false })).outputFiles[0].text).toString('base64'));
const D = await load('web/src/input/dualsense.ts');
const zones = (from, s) => Array.from({ length: 10 }, (_, i) => i >= from ? s : 0);

test('which controllers have adaptive triggers, by Chrome\'s Gamepad.id', () => {
  assert.equal(D.isDualSense('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'), true);
  assert.equal(D.isDualSense('DualSense Edge Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0df2)'), true);
  assert.equal(D.isDualSense('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)'), false);   // a DualShock 4
  assert.equal(D.isDualSense('Xbox 360 Controller (XInput STANDARD GAMEPAD)'), false);
});

test('an effect as the report\'s 11 bytes: zones under a mask, 3 bits of strength each', () => {
  assert.deepEqual([...D.triggerBytes(D.TRIGGER_OFF)], [0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // strength 8 from zone 0: every zone in use, every strength 7
  assert.deepEqual([...D.triggerBytes({ kind: 'push', zones: zones(0, 8) })], [0x21, 0xff, 0x03, 0xff, 0xff, 0xff, 0x3f, 0, 0, 0, 0]);
  // strength 1 from zone 9: the last zone alone, its strength 0
  assert.deepEqual([...D.triggerBytes({ kind: 'push', zones: zones(9, 1) })], [0x21, 0x00, 0x02, 0, 0, 0, 0, 0, 0, 0, 0]);
  // strength 3 (2 in the report) on zones 2 and up
  const b = D.triggerBytes({ kind: 'push', zones: zones(2, 3) });
  let force = 0;
  for (let i = 2; i < 10; i++) force += 2 * 2 ** (3 * i);
  assert.deepEqual([...b.slice(0, 7)], [0x21, 0xfc, 0x03, force & 0xff, (force >>> 8) & 0xff, (force >>> 16) & 0xff, (force >>> 24) & 0xff]);
  // a shake: the same zones, the frequency its ninth parameter
  const s = D.triggerBytes({ kind: 'shake', hz: 38, zones: zones(3, 4) });
  assert.equal(s[0], 0x26); assert.equal(s[1], 0xf8); assert.equal(s[2], 0x03); assert.equal(s[9], 38);
  // nothing in any zone lets the trigger go
  assert.deepEqual([...D.triggerBytes({ kind: 'push', zones: zones(0, 0) })], [0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('the report on a cable: 0x02, the triggers\' two bits alone, R2 at 10 and L2 at 21', () => {
  const r2 = { kind: 'push', zones: zones(2, 2) }, l2 = { kind: 'shake', hz: 14, zones: zones(5, 6) };
  const { id, data } = D.triggerReport(r2, l2, false);
  assert.equal(id, 0x02); assert.equal(data.length, 47);
  assert.equal(data[0], 0x0c); assert.equal(data[1], 0);          // not the motors, not the lights
  assert.deepEqual([...data.slice(10, 21)], [...D.triggerBytes(r2)]);
  assert.deepEqual([...data.slice(21, 32)], [...D.triggerBytes(l2)]);
  assert.ok([...data.slice(2, 10), ...data.slice(32)].every(v => v === 0));
});

test('the report over Bluetooth: 0x31, a sequence and a tag, the same 47 bytes, a CRC-32 at the end', () => {
  const r2 = { kind: 'push', zones: zones(1, 8) }, l2 = D.TRIGGER_OFF;
  const usb = D.triggerReport(r2, l2, false).data;
  const { id, data } = D.triggerReport(r2, l2, true, 5);
  assert.equal(id, 0x31); assert.equal(data.length, 77);
  assert.equal(data[0], 0x50); assert.equal(data[1], 0x10);
  assert.deepEqual([...data.slice(2, 49)], [...usb]);
  const want = zlib.crc32(Buffer.concat([Buffer.from([0xa2, 0x31]), Buffer.from(data.slice(0, 73))]));
  assert.equal(new DataView(data.buffer).getUint32(73, true), want);
  assert.equal(D.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

const base = { drive: 1, shown: true, speed: 0, rpm: 900, gear: 2, throttle: 0, brake: 0, hit: 0 };

test('not driving, or the page hidden: both triggers let go', () => {
  const f = new D.TriggerFeel();
  assert.deepEqual(f.effects({ ...base, now: 0, drive: 0 }), { r2: D.TRIGGER_OFF, l2: D.TRIGGER_OFF });
  assert.deepEqual(f.effects({ ...base, now: 10, shown: false }), { r2: D.TRIGGER_OFF, l2: D.TRIGGER_OFF });
});

test('driving: a light spring on the throttle, a brake that stiffens with the speed', () => {
  const f = new D.TriggerFeel();
  const slow = f.effects({ ...base, now: 0 });
  assert.deepEqual(slow.r2, { kind: 'push', zones: zones(2, 2) });
  assert.deepEqual(slow.l2, { kind: 'push', zones: zones(1, 2) });
  const fast = f.effects({ ...base, now: 20, speed: 60, gear: 5, rpm: 5000 });
  assert.deepEqual(fast.l2, { kind: 'push', zones: zones(1, 7) });
  // a game that says only "drive": the springs alone
  const old = new D.TriggerFeel().effects({ now: 0, drive: 2, shown: true, throttle: 1, brake: 1, hit: 0 });
  assert.deepEqual(old, { r2: { kind: 'push', zones: zones(2, 2) }, l2: { kind: 'push', zones: zones(1, 2) } });
});

test('the brake held down hard at speed judders; not while reversing', () => {
  const f = new D.TriggerFeel();
  const e = f.effects({ ...base, now: 0, speed: 40, gear: 4, rpm: 5000, brake: 1 });
  assert.equal(e.l2.kind, 'shake');
  assert.equal(f.effects({ ...base, now: 20, speed: 40, gear: 4, rpm: 5000, brake: 0.5 }).l2.kind, 'push');
  assert.equal(f.effects({ ...base, now: 40, speed: 20, gear: 0, rpm: 5000, brake: 1 }).l2.kind, 'push');
});

test('a shift between forward gears kicks the throttle for a moment', () => {
  const f = new D.TriggerFeel();
  f.effects({ ...base, now: 0, speed: 20, gear: 2, rpm: 6000, throttle: 1 });
  const kick = f.effects({ ...base, now: 16, speed: 20, gear: 3, rpm: 4500, throttle: 1 });
  assert.deepEqual(kick.r2, { kind: 'push', zones: zones(1, 8) });
  // after it, the throttle still down: the engine's hum; let up to a third: the spring
  const after = f.effects({ ...base, now: 200, speed: 21, gear: 3, rpm: 4600, throttle: 1 });
  assert.equal(after.r2.kind, 'shake'); assert.deepEqual(after.r2.zones, zones(4, 2));
  assert.deepEqual(f.effects({ ...base, now: 220, speed: 21, gear: 3, rpm: 4600, throttle: 0.3 }).r2, { kind: 'push', zones: zones(2, 2) });
  // into first from neutral (the start) is none
  const g = new D.TriggerFeel();
  g.effects({ ...base, now: 0, gear: 1 });
  assert.deepEqual(g.effects({ ...base, now: 16, gear: 2 }).r2, { kind: 'push', zones: zones(2, 2) });
});

/** the limiter's shake (from the fourth tenth of the travel, strength 4), not the hum (from the fifth) */
const atTop = (e) => e.kind === 'shake' && e.zones[3] === 4;

test('the top of the revs shakes the throttle, once the engine has shown where it is', () => {
  const f = new D.TriggerFeel();
  let now = 0;
  // the first run up through the revs: no shake on the way
  for (let rpm = 1000; rpm <= 8000; rpm += 250) {
    const e = f.effects({ ...base, now: now += 16, speed: 30, gear: 3, rpm, throttle: 1 });
    assert.equal(atTop(e.r2), false, `at ${rpm} rpm`);
  }
  // the shift: the revs fall, the top is known
  f.effects({ ...base, now: now += 16, speed: 31, gear: 4, rpm: 5500, throttle: 1 });
  now += 300;
  assert.equal(atTop(f.effects({ ...base, now: now += 16, speed: 40, gear: 4, rpm: 7000, throttle: 1 }).r2), false);
  const top = f.effects({ ...base, now: now += 16, speed: 45, gear: 4, rpm: 7900, throttle: 1 });
  assert.deepEqual(top.r2, { kind: 'shake', hz: 38, zones: zones(3, 4) });
  // off the throttle up there: the spring
  assert.equal(f.effects({ ...base, now: now += 16, speed: 45, gear: 4, rpm: 7900, throttle: 0 }).r2.kind, 'push');

  // held on the limiter without a shift: known after a moment
  const g = new D.TriggerFeel();
  now = 0;
  for (let rpm = 1000; rpm <= 8000; rpm += 500) g.effects({ ...base, now: now += 16, speed: 30, gear: 3, rpm, throttle: 1 });
  assert.equal(atTop(g.effects({ ...base, now: now += 100, speed: 30, gear: 3, rpm: 8000, throttle: 1 }).r2), false);
  assert.equal(atTop(g.effects({ ...base, now: now += 400, speed: 30, gear: 3, rpm: 8000, throttle: 1 }).r2), true);
});

test('a crash shakes both', () => {
  const f = new D.TriggerFeel();
  const e = f.effects({ ...base, now: 0, speed: 30, gear: 3, rpm: 5000, hit: 0.9 });
  assert.deepEqual(e.r2, { kind: 'shake', hz: 22, zones: zones(0, 8) });
  assert.deepEqual(e.l2, e.r2);
});

test('a controller picked before opens while the game runs, takes the effects when they change, and is let go at the end', async () => {
  const sent = [];
  const dev = Object.assign(new EventTarget(), {
    opened: false, vendorId: 0x054c, productId: 0x0ce6, productName: 'DualSense Wireless Controller',
    collections: [{ outputReports: [{ reportId: 0x31 }] }],                       // Bluetooth's
    async open() { this.opened = true; }, async close() { this.opened = false; },
    async sendReport(id, data) { sent.push({ id, data: Uint8Array.from(data) }); },
  });
  const hid = Object.assign(new EventTarget(), { getDevices: async () => [dev], requestDevice: async () => [dev] });
  Object.defineProperty(globalThis.navigator, 'hid', { value: hid, configurable: true });
  globalThis.addEventListener ??= () => {}; globalThis.removeEventListener ??= () => {};
  const tick = () => new Promise(r => setTimeout(r, 5));
  try {
    assert.deepEqual(await D.dualSensePicked(), ['DualSense']);
    const lines = [], done = D.useDualSense(s => lines.push(s));
    await tick();
    assert.equal(dev.opened, true); assert.equal(D.dualSenseOpen(), true);
    assert.match(lines.join('\n'), /adaptive triggers on \(Bluetooth\)/);
    const status = new Map([['drive', 1], ['car_speed', 60], ['car_rpm', 5000], ['car_gear', 5]]);
    const t = new D.TriggerDriver(() => status);
    const pad = { connected: true, buttons: 0, axes: [0, 0, 0, 0, 0, 0], family: 2, name: 'DualSense', index: 0 };
    const id = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
    t.update(id, pad, 0); t.update(id, pad, 0);
    await tick();
    assert.equal(sent.length, 1);                                               // the same effects: once
    assert.equal(sent[0].id, 0x31);
    assert.deepEqual([...sent[0].data.slice(2 + 21, 2 + 32)], [...D.triggerBytes({ kind: 'push', zones: zones(1, 7) })]);
    // another controller drives the game's pad: this one's triggers are let go
    await new Promise(r => setTimeout(r, 40));
    t.update('Xbox 360 Controller (XInput STANDARD GAMEPAD)', pad, 0);
    await tick();
    assert.equal(sent.length, 2); assert.equal(sent[1].data[2 + 10], 0x05); assert.equal(sent[1].data[2 + 21], 0x05);
    t.update(id, pad, 0);
    done();
    await tick();
    assert.equal(sent.at(-1).data[2 + 10], 0x05);
    assert.equal(dev.opened, false); assert.equal(D.dualSenseOpen(), false);
  } finally { delete globalThis.navigator.hid; }
});

test('the game\'s rumble rides in the same report: the motors\' two bits and their levels', () => {
  const off = D.triggerReport(D.TRIGGER_OFF, D.TRIGGER_OFF, false).data;
  assert.equal(off[0], 0x0c); assert.equal(off[2], 0); assert.equal(off[3], 0);
  const { data } = D.triggerReport(D.TRIGGER_OFF, D.TRIGGER_OFF, false, 0, { strong: 1, weak: 0.5 });
  assert.equal(data[0], 0x0f);
  assert.equal(data[2], 128);   // the right (small) motor: weak
  assert.equal(data[3], 255);   // the left (big) motor: strong
  const still = D.triggerReport(D.TRIGGER_OFF, D.TRIGGER_OFF, false, 0, { strong: 0, weak: 0 }).data;
  assert.equal(still[0], 0x0f); assert.equal(still[2], 0); assert.equal(still[3], 0);
  const bt = D.triggerReport(D.TRIGGER_OFF, D.TRIGGER_OFF, true, 1, { strong: 0.2, weak: 2 }).data;
  assert.equal(bt[2], 0x0f); assert.equal(bt[4], 255); assert.equal(bt[5], 51);
});

test('the throttle held down hums with the engine: faster and stronger up the revs, the spring again once let up', () => {
  const f = new D.TriggerFeel();
  f.effects({ ...base, now: 0, speed: 30, gear: 3, rpm: 8000, throttle: 0 });            // the top of the revs seen: 8000
  const low = f.effects({ ...base, now: 16, speed: 10, gear: 3, rpm: 2000, throttle: 1 }).r2;
  const high = f.effects({ ...base, now: 32, speed: 30, gear: 3, rpm: 7000, throttle: 1 }).r2;
  assert.equal(low.kind, 'shake'); assert.equal(high.kind, 'shake');
  assert.deepEqual(low.zones, zones(4, 1)); assert.deepEqual(high.zones, zones(4, 3));
  assert.ok(low.hz < high.hz && low.hz >= 16 && high.hz <= 46, `${low.hz} ${high.hz}`);
  // it stays the hum down to 0.45 of the travel, and comes back only from 0.6
  assert.equal(f.effects({ ...base, now: 48, speed: 30, gear: 3, rpm: 7000, throttle: 0.5 }).r2.kind, 'shake');
  assert.equal(f.effects({ ...base, now: 64, speed: 30, gear: 3, rpm: 7000, throttle: 0.4 }).r2.kind, 'push');
  assert.equal(f.effects({ ...base, now: 80, speed: 30, gear: 3, rpm: 7000, throttle: 0.55 }).r2.kind, 'push');
  // reverse, and a game that does not say the revs: the spring
  assert.equal(f.effects({ ...base, now: 96, speed: 5, gear: 0, rpm: 3000, throttle: 1 }).r2.kind, 'push');
  assert.equal(new D.TriggerFeel().effects({ now: 0, drive: 1, shown: true, throttle: 1, brake: 0, hit: 0 }).r2.kind, 'push');
});

test('the brake\'s judder slows with the car', () => {
  const f = new D.TriggerFeel();
  const fast = f.effects({ ...base, now: 0, speed: 55, gear: 5, rpm: 5000, brake: 0.8 }).l2;
  const slow = f.effects({ ...base, now: 16, speed: 20, gear: 3, rpm: 5000, brake: 0.8 }).l2;
  assert.equal(fast.kind, 'shake'); assert.equal(fast.hz, 24);
  assert.equal(slow.kind, 'shake'); assert.ok(slow.hz > 10 && slow.hz < fast.hz);
});

test('the player\'s strength scales every effect, and none of them away', () => {
  const at = (scale) => new D.TriggerFeel().effects({ ...base, now: 0, speed: 60, gear: 5, rpm: 5000, brake: 0.5, scale });
  assert.deepEqual(at(1).l2, { kind: 'push', zones: zones(1, 7) });
  assert.deepEqual(at(D.STRENGTHS.medium).l2, { kind: 'push', zones: zones(1, 5) });
  assert.deepEqual(at(D.STRENGTHS.light).l2, { kind: 'push', zones: zones(1, 3) });
  assert.deepEqual(at(D.STRENGTHS.light).r2, { kind: 'push', zones: zones(2, 1) });
  assert.equal(D.triggerStrength(), 'strong');
  D.setTriggerStrength('light'); assert.equal(D.triggerStrength(), 'light');
  D.setTriggerStrength('strong');
});

test('the road on the motors: hard braking and a fast corner, from the brake, the stick and the speed', () => {
  const road = (o) => D.roadRumble({ driving: true, speed: 40, gear: 4, brake: 0, steer: 0, ...o });
  assert.deepEqual(road({}), { strong: 0, weak: 0 });
  assert.deepEqual(road({ brake: 0.5 }), { strong: 0, weak: 0 });
  const hard = road({ brake: 1 }), slow = road({ brake: 1, speed: 15 });
  assert.ok(hard.weak > slow.weak && slow.weak > 0, `${hard.weak} ${slow.weak}`);
  assert.ok(hard.strong > 0); assert.equal(slow.strong, 0);
  assert.deepEqual(road({ brake: 1, speed: 8 }), { strong: 0, weak: 0 });
  const turn = road({ steer: -1 });
  assert.ok(turn.weak > 0 && turn.weak <= 0.4);
  assert.deepEqual(road({ steer: 0.4 }), { strong: 0, weak: 0 });
  assert.deepEqual(road({ steer: 1, speed: 10 }), { strong: 0, weak: 0 });
  // lighter at a lighter strength; none in reverse, outside driving, or from a game that does not say the speed
  assert.ok(Math.abs(road({ brake: 1, scale: 0.45 }).weak - hard.weak * 0.45) < 1e-9);
  assert.deepEqual(road({ brake: 1, gear: 0 }), { strong: 0, weak: 0 });
  assert.deepEqual(road({ brake: 1, driving: false }), { strong: 0, weak: 0 });
  assert.deepEqual(D.roadRumble({ driving: true, brake: 1, steer: 1 }), { strong: 0, weak: 0 });
});

test('a DualSense over Bluetooth read from its own reports: the full one (0x31) and the short one (0x01)', () => {
  // 0x31: a tag byte, then the sticks, the triggers, a counter and the buttons as USB's 0x01 has them
  const full = new Uint8Array(77);
  full.set([0x00, 0, 255, 128, 128, 255, 64, 7, 0x20 | 0x02, 0x01 | 0x20, 0x01], 0);
  const a = D.readDualSense(0x31, new DataView(full.buffer));
  assert.ok(a);
  assert.deepEqual(a.axes.map(v => Math.round(v * 100) / 100), [-1, 1, 0, 0]);   // left stick full left and down
  assert.equal(a.buttons[0], 1);              // cross
  assert.equal(a.buttons[1], 0);              // circle
  assert.equal(a.buttons[4], 1);              // L1
  assert.equal(a.buttons[9], 1);              // Options
  assert.equal(a.buttons[6], 1);              // L2 all the way
  assert.ok(Math.abs(a.buttons[7] - 64 / 255) < 1e-9);   // R2 a quarter
  assert.equal(a.buttons[16], 1);             // PS
  assert.deepEqual(a.buttons.slice(12, 16), [0, 0, 0, 1]);   // the hat east: right
  // 0x01: the sticks, three bytes of buttons, the triggers
  const short = new Uint8Array(9);
  short.set([128, 0, 128, 128, 0x80 | 0x07, 0x02, 0x02, 0, 200]);
  const b = D.readDualSense(0x01, new DataView(short.buffer));
  assert.ok(b);
  assert.ok(b.axes[1] < -0.99);               // left stick up
  assert.equal(b.buttons[3], 1);              // triangle
  assert.equal(b.buttons[5], 1);              // R1
  assert.equal(b.buttons[17], 1);             // the touchpad
  assert.deepEqual(b.buttons.slice(12, 16), [1, 0, 1, 0]);   // the hat north-west: up and left
  assert.ok(Math.abs(b.buttons[7] - 200 / 255) < 1e-9);
  // the hat at rest, and reports of other kinds or too short
  short[4] = 0x08;
  assert.deepEqual(D.readDualSense(0x01, new DataView(short.buffer)).buttons.slice(12, 16), [0, 0, 0, 0]);
  assert.equal(D.readDualSense(0x02, new DataView(full.buffer)), null);
  assert.equal(D.readDualSense(0x31, new DataView(new ArrayBuffer(4))), null);
});
