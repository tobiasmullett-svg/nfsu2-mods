// Full Vibration (web/src/input/haptics.ts): what a DualSense's actuators play for the car's state, and when a gear
// change knocks.  The sound card itself is the browser's: a browser without one says so.
//   node --test web/test/haptics.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const H = await import('data:text/javascript;base64,' + Buffer.from((await esbuild.build({
  entryPoints: [path.join(ROOT, 'web/src/input/haptics.ts')], bundle: true, format: 'esm', write: false })).outputFiles[0].text).toString('base64'));

const base = { driving: true, speed: 0, rpm: 0, gear: 2, throttle: 0, surface: 0, hit: 0, tyres: 0, nos: false, scale: 1 };

test('nothing while not driving, whatever the game says', () => {
  assert.deepEqual(H.vibrationLevels({ ...base, driving: false, rpm: 6000, speed: 50, throttle: 1, surface: 1, hit: 1, tyres: 1, nos: true }), H.SILENT);
});

test('the engine buzzes at its firing rate, stronger with the throttle and the revs; nothing with it off', () => {
  const idle = H.vibrationLevels({ ...base, rpm: 900 }), pull = H.vibrationLevels({ ...base, rpm: 6000, throttle: 1 });
  assert.equal(idle.engineHz, 30); assert.equal(pull.engineHz, 200);
  assert.ok(pull.engine > idle.engine && idle.engine > 0);
  assert.equal(H.vibrationLevels({ ...base, rpm: 12000 }).engineHz, 260);    // past a 4-cylinder's limit: kept there
  assert.equal(H.vibrationLevels({ ...base, rpm: 0 }).engine, 0);
});

test('the road grows with the speed; the game\'s rumble, the tyres and nitrous on top; the strength scales it all', () => {
  const slow = H.vibrationLevels({ ...base, speed: 10 }), fast = H.vibrationLevels({ ...base, speed: 60 });
  assert.equal(H.vibrationLevels(base).road, 0);
  assert.ok(fast.road > slow.road && slow.road > 0);
  assert.equal(H.vibrationLevels({ ...base, speed: 500 }).road, 0.25);
  const all = H.vibrationLevels({ ...base, surface: 1, hit: 0.5, tyres: 1, nos: true, scale: 0.45 });
  assert.equal(all.surface, 0.9); assert.equal(all.hit, 0.5); assert.equal(all.tyres, 0.6); assert.equal(all.nos, 0.5);
  assert.equal(all.master, 0.45);
});

test('a knock between forward gears and into or out of reverse, not through neutral', () => {
  assert.equal(H.shifted(2, 3), true); assert.equal(H.shifted(4, 3), true); assert.equal(H.shifted(0, 2), true);
  assert.equal(H.shifted(1, 2), false); assert.equal(H.shifted(2, 1), false); assert.equal(H.shifted(3, 3), false);
  assert.equal(H.shifted(undefined, 2), false); assert.equal(H.shifted(2, undefined), false);
});

test('a browser that cannot choose where its sound goes: no vibration, and why', async () => {
  assert.deepEqual(await H.FullVibration.open(true), { ok: false, why: 'unsupported' });
});

test('the microphone refused, missing or busy: why there are no names, or the names all the same', async () => {
  const named = [{ kind: 'audioinput', label: 'Microphone (DualSense Wireless Controller)', deviceId: 'mic' },
    { kind: 'audiooutput', label: 'Speakers (DualSense Wireless Controller)', deviceId: 'ds' }];
  const blank = named.map(d => ({ ...d, label: '' }));
  // the player's answer: allow (the names show), and how opening the microphone goes after it
  let allow = false, fail, allowed = false, asked = 0, stopped = 0;
  const md = {
    enumerateDevices: async () => allowed ? named : blank,
    getUserMedia: async () => {
      asked++;
      if (allow) allowed = true;
      if (fail) throw new DOMException('no', fail);
      return { getTracks: () => [{ stop: () => { stopped++; } }] };
    },
  };
  const outputs = (ask, answer = {}) => {
    allow = !!answer.allow; fail = answer.fail; allowed = false; asked = 0; stopped = 0;
    return H.FullVibration.outputs(ask);
  };
  const had = globalThis.AudioContext;
  globalThis.AudioContext = class { setSinkId() {} };
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: md, configurable: true });
  try {
    assert.deepEqual(await outputs(false), [blank[1]]);                     // not from a click: no question
    assert.equal(asked, 0);
    assert.deepEqual(await outputs(true, { allow: true }), [named[1]]);     // allowed: the names, the microphone let go
    assert.equal(stopped, 1);
    assert.equal(await outputs(true, { fail: 'NotAllowedError' }), 'denied');
    assert.equal(await outputs(true, { fail: 'NotFoundError' }), 'none');   // no microphone: no controller on a cable
    assert.deepEqual(await outputs(true, { allow: true, fail: 'NotReadableError' }), [named[1]]);   // held elsewhere
  } finally {
    delete globalThis.navigator.mediaDevices;
    globalThis.AudioContext = had;
  }
});
