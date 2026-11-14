// haptics.ts -- Full Vibration (settings.ini full_vibration): a DualSense's fine vibration from the game.
//
// On a USB cable a DualSense is a sound card too, of 4 channels: 1 and 2 its speaker and headphone socket, 3 and 4 the
// actuators in its left and right grip.  What plays on those two is felt, not heard: that is how a PS5 game makes its
// vibration, and how a page can, with the browser's sound (Web Audio on that card: AudioContext's sinkId, Chrome 110).
// Over Bluetooth that sound goes a way of Sony's own that a page cannot reach: there the controller rumbles as before
// (dualsense.ts, its motors).
//
// The page knows the card by its name (Windows: "DualSense Wireless Controller", or "Wireless Controller"), which
// Chrome shows a page only once it may use the microphone: the switch and the Controls sheet's test ask once.  Nothing
// is recorded: the microphone is let go at once.  Windows has to give the card its 4 channels; with 2 there is nothing
// to play the vibration on, and the test says so.
//
// What plays while the player drives (vibrationLevels):
//   the engine   a buzz at its firing rate (rpm / 30: a 4-cylinder's), stronger with the throttle and the revs
//   the road     low noise that grows with the speed
//   the surface  the game's own light rumble (a kerb, the verge, a change of surface) as a rumble strip's pulses
//   a crash      the game's strong rumble, as a heavy thump
//   the tyres    Road Rumble's (roadrumble.ts): a scrub under hard braking and in fast corners
//   nitrous      a fluttering roar while it fires (the game's status "car_nos")
//   a shift      a knock as the gear changes
// as strong as the triggers are set (full with them off), through a compressor so that all of it at once does not
// clip; nothing outside driving.  While it plays the controller's motors stay still (dualsense.ts Pad): the vibration is
// all here.

/** the controller's sound card, by the name Windows gives it */
const CARD = /dualsense|wireless controller/i;

/** why there is no vibration: no Web Audio output choice here; the microphone refused (so no names); no such card (not
 *  on a cable); names not shown yet (not asked); the card with fewer than 4 channels */
export type VibrationFault = 'unsupported' | 'denied' | 'none' | 'permission' | 'channels';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** what the vibration comes from, each time the controller is read */
export interface VibrationInput {
  /** the player drives, the page shown */
  driving: boolean;
  /** the car's speed (m/s), its engine's rpm, its gear (0 reverse, 1 neutral, 2 first ..); undefined: not said */
  speed?: number; rpm?: number; gear?: number;
  /** the throttle, 0..1 */
  throttle: number;
  /** the game's light and strong rumble, 0..1 (its weak and strong motor) */
  surface: number; hit: number;
  /** Road Rumble's tyres, 0..1 */
  tyres: number;
  /** the nitrous fires */
  nos: boolean;
  /** how strong all of it is, 0..1 */
  scale: number;
}
/** each sound's level (0..1, before the compressor) and the engine's frequency (Hz) */
export interface VibrationLevels { engine: number; engineHz: number; road: number; surface: number; hit: number; tyres: number; nos: number; master: number }

export const SILENT: VibrationLevels = { engine: 0, engineHz: 30, road: 0, surface: 0, hit: 0, tyres: 0, nos: 0, master: 0 };

/** the levels for the car's state: nothing while not driving */
export function vibrationLevels(i: VibrationInput): VibrationLevels {
  if (!i.driving) return SILENT;
  const rpm = i.rpm ?? 0, speed = Math.abs(i.speed ?? 0);
  return {
    engine: rpm > 0 ? 0.06 + 0.12 * clamp(i.throttle, 0, 1) + 0.06 * clamp((rpm - 1000) / 7000, 0, 1) : 0,
    engineHz: clamp(rpm / 30, 20, 260),
    road: 0.25 * Math.sqrt(clamp(speed / 70, 0, 1)),
    surface: 0.9 * clamp(i.surface, 0, 1),
    hit: clamp(i.hit, 0, 1),
    tyres: 0.6 * clamp(i.tyres, 0, 1),
    nos: i.nos ? 0.5 : 0,
    master: clamp(i.scale, 0, 1),
  };
}

/** a gear change worth a knock: forward gears both (2 first and up), or into or out of reverse; not through neutral */
export const shifted = (from: number | undefined, to: number | undefined) =>
  from !== undefined && to !== undefined && from !== to && from !== 1 && to !== 1 && from >= 0 && to >= 0;

// ---- the sounds ------------------------------------------------------------------------------------------------------

/** a mono buffer of secs seconds, f(t) each sample */
function buffer(ctx: BaseAudioContext, secs: number, f: (t: number) => number): AudioBuffer {
  const n = Math.max(1, Math.round(secs * ctx.sampleRate)), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = f(i / ctx.sampleRate);
  return b;
}
const TAU = 2 * Math.PI;
/** white noise */
const noise = (ctx: BaseAudioContext) => buffer(ctx, 2, () => Math.random() * 2 - 1);
/** a rumble strip: a 110 Hz buzz in 16 bursts a second (a whole number of each in a second, so it loops cleanly) */
const strip = (ctx: BaseAudioContext) => buffer(ctx, 1, t => Math.sin(TAU * 110 * t) * ((t * 16) % 1 < 0.45 ? 1 : 0));
/** a crash's thump: 42 Hz, swelling 7 times a second */
const thump = (ctx: BaseAudioContext) => buffer(ctx, 1, t => Math.sin(TAU * 42 * t) * (0.65 + 0.35 * Math.sin(TAU * 7 * t)));
/** nitrous: noise smoothed to a rumble, fluttering 9 times a second */
function flutter(ctx: BaseAudioContext): AudioBuffer {
  let y = 0;
  return buffer(ctx, 1, t => (y += 0.08 * ((Math.random() * 2 - 1) - y)) * 3 * (0.6 + 0.4 * Math.sin(TAU * 9 * t)));
}
/** a shift's knock: a short 55 Hz blow and a click */
const knock = (ctx: BaseAudioContext) => buffer(ctx, 0.09, t => Math.sin(TAU * 55 * t) * Math.exp(-t * 35) + (Math.random() * 2 - 1) * 0.4 * Math.exp(-t * 90));
/** a sweep from 50 to 250 Hz (the test's left and right) */
function sweep(ctx: BaseAudioContext, secs: number): AudioBuffer {
  let ph = 0, last = 0;
  return buffer(ctx, secs, t => { ph += TAU * 50 * Math.pow(5, t / secs) * (t - last); last = t; return Math.sin(ph) * 0.9 * Math.min(1, t / 0.03, (secs - t) / 0.03); });
}

/** A DualSense's sound card open for its vibration (open: from the card's name; ask: may ask for the microphone). */
export class FullVibration {
  private master: GainNode;
  private engineOsc: OscillatorNode;
  private gains: Record<'engine' | 'road' | 'surface' | 'hit' | 'tyres' | 'nos', GainNode>;
  private sources: AudioScheduledSourceNode[] = [];
  private merger: ChannelMergerNode;
  private gear: number | undefined;
  private closed = false;

  /** the card's outputs (with their names once the microphone may be used); ask: ask for it when the names are not
   *  shown (from a click: the switch, the Controls sheet's test) */
  static async outputs(ask: boolean): Promise<MediaDeviceInfo[] | VibrationFault> {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.enumerateDevices || typeof AudioContext === 'undefined' || !('setSinkId' in AudioContext.prototype)) return 'unsupported';
    const outs = async () => (await md.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    const list = await outs();
    if (list.some(d => d.label) || !ask) return list;
    try {
      const s = await md.getUserMedia({ audio: true });
      for (const tr of s.getTracks()) tr.stop();
    } catch { return 'denied'; }
    return outs();
  }

  static async open(ask: boolean): Promise<{ ok: true; vib: FullVibration } | { ok: false; why: VibrationFault; channels?: number }> {
    const list = await FullVibration.outputs(ask);
    if (typeof list === 'string') return { ok: false, why: list };
    const dev = list.find(d => CARD.test(d.label));
    if (!dev) return { ok: false, why: list.some(d => d.label) ? 'none' : 'permission' };
    let ctx: AudioContext;
    try { ctx = new AudioContext({ latencyHint: 'interactive', sinkId: dev.deviceId }); }
    catch { return { ok: false, why: 'none' }; }
    if (ctx.sinkId !== dev.deviceId) {
      try { await ctx.setSinkId(dev.deviceId); } catch { void ctx.close(); return { ok: false, why: 'none' }; }
    }
    const max = ctx.destination.maxChannelCount;
    if (max < 4) { void ctx.close(); return { ok: false, why: 'channels', channels: max }; }
    try { await ctx.resume(); } catch { /* it starts with the next click on the page */ }
    return { ok: true, vib: new FullVibration(ctx, dev.label) };
  }

  private constructor(readonly ctx: AudioContext, readonly label: string) {
    const d = ctx.destination;
    d.channelCount = 4; d.channelCountMode = 'explicit'; d.channelInterpretation = 'discrete';
    const merger = this.merger = ctx.createChannelMerger(4);
    merger.connect(d);
    // all of it, mono, through a compressor onto both grips (channels 3 and 4)
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8; comp.knee.value = 6; comp.ratio.value = 10; comp.attack.value = 0.002; comp.release.value = 0.08;
    const mix = ctx.createGain();
    mix.connect(comp);
    comp.connect(merger, 0, 2); comp.connect(merger, 0, 3);
    const master = this.master = ctx.createGain();
    master.gain.value = 0;
    master.connect(mix);
    const gain = (from: AudioNode) => { const g = ctx.createGain(); g.gain.value = 0; from.connect(g); g.connect(master); return g; };
    const filter = (from: AudioNode, type: BiquadFilterType, hz: number, q = 0.7) => {
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = hz; f.Q.value = q; from.connect(f); return f;
    };
    const loop = (b: AudioBuffer) => { const s = ctx.createBufferSource(); s.buffer = b; s.loop = true; s.start(); this.sources.push(s); return s; };
    const osc = this.engineOsc = ctx.createOscillator();
    osc.type = 'sawtooth'; osc.frequency.value = 30; osc.start(); this.sources.push(osc);
    const hiss = loop(noise(ctx));
    this.gains = {
      engine: gain(filter(osc, 'lowpass', 260)),
      road: gain(filter(filter(hiss, 'lowpass', 120), 'highpass', 25)),
      tyres: gain(filter(hiss, 'bandpass', 170, 1.5)),
      surface: gain(loop(strip(ctx))),
      hit: gain(loop(thump(ctx))),
      nos: gain(loop(flutter(ctx))),
    };
  }

  /** the vibration for the car's state now */
  update(i: VibrationInput) {
    if (this.closed) return;
    const v = vibrationLevels(i), t = this.ctx.currentTime;
    for (const k of ['engine', 'road', 'surface', 'hit', 'tyres', 'nos'] as const) this.gains[k].gain.setTargetAtTime(v[k], t, 0.03);
    this.engineOsc.frequency.setTargetAtTime(v.engineHz, t, 0.05);
    this.master.gain.setTargetAtTime(v.master, t, 0.05);
    if (i.driving && shifted(this.gear, i.gear)) this.once(knock(this.ctx), 0.9 * v.master, [2, 3]);
    this.gear = i.driving ? i.gear : undefined;
  }

  /** a sound once, at a level, onto those of the card's channels (not through the compressor: a knock or the test) */
  private once(b: AudioBuffer, level: number, channels: readonly number[]) {
    const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
    s.buffer = b; g.gain.value = level;
    s.connect(g);
    for (const ch of channels) g.connect(this.merger, 0, ch);
    s.start();
    return b.duration;
  }

  /** The Controls sheet's test: the left grip, the right grip, then both with the road, a kerb and the engine revving
   *  (about 7 s).  Resolves when it is over. */
  async test(): Promise<void> {
    const wait = (s: number) => new Promise(r => setTimeout(r, s * 1000 + 150));
    await wait(this.once(sweep(this.ctx, 1.2), 1, [2]));
    await wait(this.once(sweep(this.ctx, 1.2), 1, [3]));
    let y = 0;
    await wait(this.once(buffer(this.ctx, 1.5, () => (y += 0.05 * ((Math.random() * 2 - 1) - y)) * 4), 1, [2, 3]));
    await wait(this.once(buffer(this.ctx, 1.2, t => Math.sin(TAU * 110 * t) * ((t * 16) % 1 < 0.45 ? 1 : 0)), 0.9, [2, 3]));
    let ph = 0, last = 0;
    await wait(this.once(buffer(this.ctx, 2, t => {
      ph += TAU * (30 + 170 * (t / 2) ** 2) * (t - last); last = t;
      return ((ph / TAU) % 1 * 2 - 1) * 0.6 * Math.min(1, (2 - t) / 0.05);
    }), 0.8, [2, 3]));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sources) { try { s.stop(); } catch { /* already */ } }
    void this.ctx.close().catch(() => {});
  }
}

/** how long to wait before looking for the card again after it was not there (the cable plugged in later) */
const RETRY_MS = 5000;

/** The vibration while a game runs (dualsense.ts TriggerDriver): open while the switch is on and the card is there,
 *  without asking for the microphone (the switch did, from its click); closed with the switch off and at the game's end. */
export class VibrationDriver {
  private vib: FullVibration | null = null;
  private opening = false;
  private wanted = false;
  private nextTry = 0;
  private said = '';

  constructor(private log: (s: string) => void) {}

  get active() { return !!this.vib; }

  want(on: boolean, now: number) {
    this.wanted = on;
    if (!on) { this.close(); this.nextTry = 0; return; }
    if (this.vib || this.opening || now < this.nextTry) return;
    this.opening = true;
    void FullVibration.open(false).then(r => {
      this.opening = false;
      if (r.ok && this.wanted) { this.vib = r.vib; this.say(`[vibration] on: the controller's sound card ("${r.vib.label}")`); return; }
      if (r.ok) { r.vib.close(); return; }
      // not there yet (a cable plugged in later): again in a while; the others stay as they are until the switch moves
      this.nextTry = r.why === 'none' || r.why === 'permission' ? performance.now() + RETRY_MS : Infinity;
      this.say(`[vibration] off: ${r.why === 'channels' ? `the controller's sound card has ${r.channels} channels, not 4`
        : r.why === 'permission' ? 'Chrome shows no sound cards\' names yet (the switch or the test asks for them)'
        : r.why === 'denied' ? 'the microphone was refused, so no sound cards\' names'
        : r.why === 'unsupported' ? 'this browser cannot choose where its sound goes' : 'no DualSense sound card (not on a USB cable)'}`);
    }, err => { this.opening = false; this.nextTry = Infinity; this.say(`[vibration] off: ${(err as Error)?.message ?? err}`); });
  }

  update(i: VibrationInput) { this.vib?.update(i); }

  close() { this.vib?.close(); this.vib = null; }

  /** a line once for each new state */
  private say(s: string) { if (s !== this.said) { this.said = s; this.log(s); } }
}
