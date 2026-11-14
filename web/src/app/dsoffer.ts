// The offer to connect a DualSense.  Its trigger effects, its rumble and its light need the controller given to the page
// once (WebHID, dualsense.ts: Chrome's list, opened from a click), which players did not know to do under Controls.  So
// a DualSense the browser reads as a gamepad (Chrome's Gamepad API, once a button is pressed on it) that this browser
// has not given the page gets a line saying what connecting it brings:
//   - on the start page, under Play, with Connect and Not now (Not now: not again in this browser, prefs DS_OFFER_OFF);
//   - over a running game, at the top of the column of notes (style.css .toasts), while the player is not driving (the
//     menus, the pause menu: the game's status "drive" 0), for OFFER_MS of a game at most; a click on it connects.
// Connect opens the browser's list; the controller picked works at once, and on later visits without asking
// (navigator.hid.getDevices), so the offer does not come again.

import { connectDualSense, dualSensePicked, dualSensePossible, isDualSense } from '../input/dualsense';
import type { GameSession } from './game';
import { t } from './i18n';
import { DS_OFFER_OFF, localStore } from './prefs';

/** how often the gamepads are looked at (ms), and how long the line over a game may show in all */
const POLL_MS = 1000, OFFER_MS = 20000;

export class DualSenseOffer {
  private box: HTMLElement;
  private line: HTMLButtonElement;
  private session: GameSession | null = null;
  /** the line's time left in this game (ms), and when it was last counted */
  private left = OFFER_MS;
  private countedAt = 0;
  private busy = false;

  /** page: the start page's panel with Play (the offer goes at its end); stage: the game's box (the line over it) */
  constructor(page: HTMLElement, stage: HTMLElement, private deps: { log(s: string): void }) {
    const box = this.box = document.createElement('div');
    box.className = 'ds-offer'; box.hidden = true;
    const text = document.createElement('p');
    text.className = 'msg';
    const row = document.createElement('div');
    row.className = 'row';
    const yes = document.createElement('button'), no = document.createElement('button');
    yes.type = 'button'; yes.className = 'btn';
    no.type = 'button'; no.className = 'text-btn';
    yes.onclick = () => this.connect();
    no.onclick = () => {
      localStore.set(DS_OFFER_OFF, '1');
      this.deps.log('[pad] DualSense offer: not now (not again in this browser)');
      this.draw(false);
    };
    row.append(yes, no);
    box.append(text, row);
    page.append(box);
    const b = this.line = document.createElement('button');
    b.type = 'button'; b.className = 'friend-prompt offer ds-line'; b.tabIndex = -1; b.hidden = true; b.dataset.nfsu2Ui = '';
    b.onpointerdown = e => e.preventDefault();     // the canvas keeps the focus (and with it the keyboard)
    b.onclick = () => this.connect();
    (stage.querySelector<HTMLElement>('.toasts') ?? stage).prepend(b);
    if (dualSensePossible()) window.setInterval(() => void this.poll(), POLL_MS);
  }

  /** the texts, in the page's language as it shows */
  private fill() {
    const say = t('DualSense found: connect it for its trigger effects, rumble and light.');
    this.box.querySelector('.msg')!.textContent = say;
    const [yes, no] = this.box.querySelectorAll('button');
    yes.textContent = t('Connect');
    no.textContent = t('Not now');
    this.line.textContent = say;
  }

  /** a game started: the line may show over it (OFFER_MS in all) */
  start(s: GameSession) { this.session = s; this.left = OFFER_MS; this.countedAt = performance.now(); }
  /** the game ended */
  stop() { this.session = null; this.line.hidden = true; }

  private connect() {
    if (this.busy) return;
    this.busy = true;
    connectDualSense().then(names => {
      this.deps.log(`[pad] DualSense offer: ${names.length ? `connected (${names.join(', ')})` : 'the list closed, none picked'}`);
      if (names.length) this.draw(false);
    }, err => this.deps.log(`[pad] DualSense offer: ${(err as Error)?.message ?? err}`)).finally(() => { this.busy = false; });
  }

  private async poll() {
    if (localStore.get(DS_OFFER_OFF) === '1' || document.hidden) return this.draw(false);
    let seen = false;
    try { seen = (navigator.getGamepads?.() ?? []).some(g => !!g?.connected && isDualSense(g.id)); } catch { /* none */ }
    if (!seen || (await dualSensePicked()).length) return this.draw(false);
    this.draw(true);
  }

  /** the offer where it goes now: on the start page with no game, over a game while not driving (and its time lasts) */
  private draw(on: boolean) {
    const s = this.session, now = performance.now();
    let menus = false;
    if (s) {
      const st = s.status?.read();
      menus = !!st && (st.get('drive') ?? 0) === 0;
      if (on && menus && !this.line.hidden) this.left -= now - this.countedAt;
      this.countedAt = now;
    }
    const line = on && !!s && menus && this.left > 0, box = on && !s;
    if ((line && this.line.hidden) || (box && this.box.hidden)) this.fill();
    if (line && this.line.hidden) this.deps.log('[pad] DualSense offer: a DualSense not connected for its triggers, the line over the game');
    this.line.hidden = !line;
    this.box.hidden = !box;
  }
}
