import { Injectable } from '@nestjs/common';
import { MOTION, RULE_DEFAULTS } from '../../shared/constants';
import { GeoService, NOISE_FLOOR_M } from './geo.service';

/** One recorded fix, as far as the trace is concerned: where, when, and how far it could have lied. */
export interface TraceRow {
  lat: number;
  lng: number;
  clientTs: Date;
  accuracyM: number | null;
}

/**
 * A silence longer than the net window means the fix at the other end of it was never *seen*
 * moving: the device dozed and woke holding a position from somewhere else. §5 refuses to call that
 * a walk, and the trace refuses to draw it as ground.
 */
const UNSEEN_LEG_S = MOTION.MAX_NET_WINDOW_S;

/**
 * How many beyond-the-band fixes an excursion may hold before it is a journey rather than a blip.
 * A device that is awake reports every 15-60 s, so a run this long already covers minutes of road —
 * the pass has no business judging it, and a real round trip is left exactly as it happened.
 */
const MAX_UNSEEN_RUN_FIXES = 6;

/**
 * The one trace rule every reader of a day shares (CONTRACT §5): positions that cannot be ground
 * stay in the list, flagged, and out of the line, the mileage and the stops. GET /positions/route,
 * /positions/trails, the stored RouteLine, a trip's length on close and the reports' route table all
 * call this, so none of them can disagree with the motion state the classifier committed.
 */
@Injectable()
export class TraceService {
  constructor(private readonly geo: GeoService) {}

  /** The day as ground: pass 1 (impossible steps) then pass 2 (unwatched round trips). */
  groundTrace<T extends TraceRow>(rows: T[]): T[] {
    const day = this.dropSpikes(rows);
    this.dropOutAndBack(day);
    return day.filter((x) => x.credible).map((x) => x.row);
  }

  /**
   * Pass 1: fixes that cannot be ground. A position needing more than MAX_CREDIBLE_SPEED_KMH from
   * the last kept one is a spike — unless the fix right after it lands on the same spot, which is
   * what a real relocation looks like (he moved and stayed there). A cached last-known position
   * re-published in the middle of the day is the other case: there and back.
   */
  dropSpikes<T extends TraceRow>(rows: T[]): { row: T; credible: boolean }[] {
    const out: { row: T; credible: boolean }[] = [];
    let kept: T | null = null;
    rows.forEach((r, i) => {
      if (!kept) {
        kept = r;
        out.push({ row: r, credible: true });
        return;
      }
      const dtS = (r.clientTs.getTime() - kept.clientTs.getTime()) / 1000;
      const kmh = dtS > 0 ? (this.geo.distanceM(kept, r) / dtS) * 3.6 : Infinity;
      if (kmh <= MOTION.MAX_CREDIBLE_SPEED_KMH) {
        kept = r;
        out.push({ row: r, credible: true });
        return;
      }
      const n = rows[i + 1];
      const staysThere = !!n && this.geo.distanceM(r, n) <= Math.max(n.accuracyM ?? 0, NOISE_FLOOR_M);
      if (staysThere) kept = r;
      out.push({ row: r, credible: staysThere });
    });
    return out;
  }

  /**
   * Pass 2: the round trip nobody saw. A run of fixes that leaves the day's drift band and comes
   * back into it crossed no ground unless the road itself was reported — fixes a normal cadence
   * apart on the way out *and* on the way back. A phone that dozed and woke holding a cached fix from
   * the other side of the city uploads one point 1.2 km away, maybe a second beside it, then lands
   * back where it started: no net window ever existed across either leg, so the coordinates never
   * claimed the trip. Drawing it anyway gave a driver who had not moved since check-in a 7 km line
   * while his state read متوقف.
   */
  dropOutAndBack(day: { row: TraceRow; credible: boolean }[]): void {
    const band = RULE_DEFAULTS.accuracyDriftM;
    const apartS = (a: TraceRow, b: TraceRow) => Math.abs(b.clientTs.getTime() - a.clientTs.getTime()) / 1000;
    const kept = day.filter((d) => d.credible);
    let i = 0;
    for (;;) {
      const anchor = kept[i]?.row;
      if (!anchor) return;
      let j = i + 1;
      while (j < kept.length && this.geo.distanceM(anchor, kept[j].row) <= band) j++;
      if (j >= kept.length) return;
      let k = j;
      // Only a short blip can be a ghost: look for the return within the cap, never across a journey.
      while (k < kept.length && k - j < MAX_UNSEEN_RUN_FIXES && this.geo.distanceM(anchor, kept[k].row) > band) k++;
      const cameBack = k < kept.length && this.geo.distanceM(anchor, kept[k].row) <= band;
      // Both legs witnessed at the device's own cadence, or the excursion is a claim on thin air.
      const witnessed =
        apartS(anchor, kept[j].row) <= UNSEEN_LEG_S && (!cameBack || apartS(kept[k - 1].row, kept[k].row) <= UNSEEN_LEG_S);
      if (cameBack && !witnessed) for (let m = j; m < k; m++) kept[m].credible = false;
      // Either way the day carries on past the excursion: back at the anchor, or relocated to the
      // place he stayed at.
      i = cameBack ? k : j;
    }
  }

  /**
   * The ground one step covers, in metres — see `GeoService.groundDistanceM`. A step shorter than
   * the fixes' own motion circle is the phone jittering in place, and the classifier refuses to read
   * it as speed, so no mileage sum may read it as distance either.
   */
  stepMetres(a: TraceRow, b: TraceRow): number {
    return this.geo.groundDistanceM(
      { lat: a.lat, lng: a.lng, at: a.clientTs.getTime(), accuracyM: a.accuracyM },
      { lat: b.lat, lng: b.lng, at: b.clientTs.getTime(), accuracyM: b.accuracyM },
    );
  }

  /**
   * A stop is on the day only where a fix the trace stands behind happened. A cached fix from the
   * other side of the city used to plant an amber marker a kilometre from a driver who never moved,
   * contradicting the line right next to it.
   */
  groundedStops<T extends { lat: number; lng: number }, S extends { lat: number; lng: number }>(trace: T[], stops: S[]): S[] {
    const band = RULE_DEFAULTS.accuracyDriftM;
    return stops.filter((s) => trace.some((t) => this.geo.distanceM(t, s) <= band));
  }
}
