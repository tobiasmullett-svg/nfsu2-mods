// roadrumble.ts -- the road on a DualSense's motors (Road Rumble, settings.ini road_rumble): the tyres under hard
// braking and in a fast corner, played beside the game's own rumble by dualsense.ts, which sends both in its report.

/** the controller's two motors, 0..1 each */
export interface Rumble { strong: number; weak: number }

/** what the road's rumble comes from */
export interface RoadInput {
  /** whether this controller drives a car on a page that shows */
  driving: boolean;
  /** the car's speed (m/s) and its gear (0 reverse); undefined: a game that does not say */
  speed?: number; gear?: number;
  /** the brake, 0..1, and the steering, -1..1 */
  brake: number; steer: number;
  /** how strong, 0..1 (undefined: 1) */
  scale?: number;
}
/**
 * The road on the motors, beside the game's own rumble (which says a surface's change and a hit, little else): the
 * tyres under hard braking (the brake past 0.6 above 12 m/s, growing to 55 m/s; the big motor joins past 0.9 above
 * 25 m/s) and in a fast corner (the stick past half its way above 18 m/s, growing to 55 m/s; the big motor joins on
 * the hardest).  From the controller and the car's speed: the game's status has no word for the tyres' slip.
 */
export function roadRumble(i: RoadInput): Rumble {
  const speed = Math.abs(i.speed ?? 0);
  if (!i.driving || i.speed === undefined || i.gear === 0) return { strong: 0, weak: 0 };
  let strong = 0, weak = 0;
  const b = Math.max(0, Math.min(1, (i.brake - 0.6) / 0.4)), bv = Math.max(0, Math.min(1, (speed - 12) / 43));
  if (b > 0 && speed > 12) {
    weak = b * (0.15 + 0.35 * bv);
    if (i.brake > 0.9 && speed > 25) strong = 0.12 + 0.18 * bv;
  }
  const c = Math.max(0, Math.min(1, (Math.abs(i.steer) - 0.5) / 0.5)) * Math.max(0, Math.min(1, (speed - 18) / 37));
  if (c > 0) {
    weak = Math.max(weak, 0.1 + 0.3 * c);
    if (c > 0.7) strong = Math.max(strong, 0.15 * c);
  }
  const k = i.scale ?? 1;
  return { strong: strong * k, weak: weak * k };
}
