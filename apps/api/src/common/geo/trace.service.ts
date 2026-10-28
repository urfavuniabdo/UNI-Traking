import { Injectable } from '@nestjs/common';
import { MOTION, RULE_DEFAULTS } from '../../shared/constants';
import { GeoService, NOISE_FLOOR_M } from './geo.service';

/** One recorded fix, as far as the trace is concerned: where, when, and how far it could have lied. */
export interface TraceRow {
  lat: number;
  lng: number;
  clientTs: Date;
  accuracyM: number | null;
  /**
   * The speed the device reported with the fix. Optional: a reader that only pulls coordinates
   * cannot be asked to judge a speed profile, and an excursion is only refused by this test when
   * the day's speeds are actually present.
   */
  speedKmh?: number | null;
}

/** The average position of a set of fixes — where GPS drift cancels out and the place shows. */
function meanOf(rows: TraceRow[]): { lat: number; lng: number } {
  const sum = rows.reduce((a, r) => ({ lat: a.lat + r.lat, lng: a.lng + r.lng }), { lat: 0, lng: 0 });
  return { lat: sum.lat / rows.length, lng: sum.lng / rows.length };
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

  /** The day as ground: impossible steps out, unwatched round trips out, then every stand-by
   *  collapse into the one place it happened. */
  groundTrace<T extends TraceRow>(rows: T[]): T[] {
    return this.collapseStays(this.dropAndClean(rows));
  }

  /**
   * The instant the day's ground may begin: the first fix's time plus the receiver's cold-start
   * window (MOTION.CONVERGENCE_WARMUP_S). Fixes inside it are stored and replayable but found no
   * place, no line, no mileage and no stop anchor — a converging receiver reports a self-consistent
   * fiction, and no per-fix guard can refuse it because it never contradicts itself.
   */
  warmupEndMs(rows: { clientTs: Date }[]): number {
    if (!rows.length) return 0;
    const first = rows.reduce((min, r) => Math.min(min, r.clientTs.getTime()), Infinity);
    return first + MOTION.CONVERGENCE_WARMUP_S * 1000;
  }

  private dropAndClean<T extends TraceRow>(rows: T[]): T[] {
    const day = this.dropSpikes(rows);
    this.dropOutAndBack(day);
    const warmEndMs = this.warmupEndMs(rows);
    for (const d of day) if (d.credible && d.row.clientTs.getTime() < warmEndMs) d.credible = false;
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
      // Only a short blip is judged on cadence: past the cap the run is long enough to be a real
      // journey, and nothing but its own physics may call it a ghost.
      let k = j;
      while (k < kept.length && k - j < MAX_UNSEEN_RUN_FIXES && this.geo.distanceM(anchor, kept[k].row) > band) k++;
      const cameBackShort = k < kept.length && this.geo.distanceM(anchor, kept[k].row) <= band;
      // Both legs witnessed at the device's own cadence, or the excursion is a claim on thin air.
      const witnessed =
        apartS(anchor, kept[j].row) <= UNSEEN_LEG_S && (!cameBackShort || apartS(kept[k - 1].row, kept[k].row) <= UNSEEN_LEG_S);
      if (cameBackShort && !witnessed) {
        for (let m = j; m < k; m++) kept[m].credible = false;
        i = k;
        continue;
      }
      // A long excursion that returns to the very place it left is refused by its own numbers: a
      // receiver waking from idle reports speed and position out of the same fictional solution, and
      // they contradict each other (see `profilePossible`). Judged on the excursion's own fixes only
      // — the leg from the anchor is the cadence rule's business, and a day of ground must not be
      // erased by one claim the phone made while it was still sitting at home.
      let e = j;
      while (e < kept.length && this.geo.distanceM(anchor, kept[e].row) > band) e++;
      if (e < kept.length && !this.profilePossible(kept.slice(j, e + 1).map((x) => x.row))) {
        for (let m = j; m < e; m++) kept[m].credible = false;
        i = e;
        continue;
      }
      // Either way the day carries on past the excursion: back at the anchor, or relocated to the
      // place he stayed at.
      i = e < kept.length ? e : j;
    }
  }

  /**
   * Did this run's own speed profile happen? Two readings of the same journey have to agree with
   * each other: the metres between consecutive fixes, and the speed the device says it was doing
   * while covering them. A receiver waking from a long idle delivers both out of the same fictional
   * solution, and the 2026-10-26 one said 52 km/h for 42 seconds while its fixes moved 10 metres,
   * and asked for 8.1 m/s² between two of them. No car and no pair of feet performs either — so an
   * excursion that leaves a place and comes back to it while its own numbers contradict each other
   * is not ground, however many fixes it brought. A run reported without speeds (a reader that only
   * pulls coordinates) is left alone: this test needs the device's claim to contradict.
   */
  private profilePossible(run: TraceRow[]): boolean {
    for (let m = 1; m < run.length; m++) {
      const a = run[m - 1];
      const b = run[m];
      const dtS = (b.clientTs.getTime() - a.clientTs.getTime()) / 1000;
      // Past the net window the phone was not seen moving at all, so its speed at the start of the
      // silence says nothing about the metres between: a driver who pulled over and switched off is
      // exactly a fast reading followed by a long gap. That case belongs to the cadence rule.
      if (!(dtS > 0) || dtS > MOTION.MAX_NET_WINDOW_S || a.speedKmh == null || b.speedKmh == null) continue;
      if (Math.abs(b.speedKmh - a.speedKmh) / 3.6 / dtS > MOTION.MAX_ACCEL_MS2) return false;
      const claimedM = ((a.speedKmh + b.speedKmh) / 2 / 3.6) * dtS;
      const groundM = this.geo.distanceM(a, b);
      const slackM = Math.max(a.accuracyM ?? 0, b.accuracyM ?? 0, NOISE_FLOOR_M) * 2 + (MOTION.STATIONARY_SPEED_KMH / 3.6) * dtS;
      if (claimedM > 3 * (groundM + slackM)) return false;
    }
    return true;
  }

  /**
   * A stand-by is a place, not a path. Consecutive fixes that never left one place — every one of
   * them inside the day's drift band of their centre, and the window between the mean of their older
   * half and the mean of their newer half never beat the noise bubble (§5's own arithmetic) — are
   * collapsed to a single point at that place. A phone dozing on a desk jitters 30-50 m around its
   * driver all hour; drawn fix-by-fix that jitter is a red star of spokes and 0.1 km of "route" for
   * a man who has not moved since check-in, which contradicts the متوقف next to it. He gets one dot:
   * نقطة وقوفه. A driver who actually walks blows the bubble within a few fixes, so his run breaks
   * and the line between the run points is the road he took — distance and speed still decide it.
   */
  collapseStays<T extends TraceRow>(trace: T[]): T[] {
    const out: T[] = [];
    let run: T[] = [];
    for (const fix of trace) {
      if (!run.length) {
        run = [fix];
        continue;
      }
      if (this.stayedPut([...run, fix])) {
        run.push(fix);
        continue;
      }
      out.push(this.stayPoint(run));
      run = [fix];
    }
    if (run.length) out.push(this.stayPoint(run));
    return out;
  }

  /**
   * Does this list of fixes describe one place a driver never left? Public because the motion
   * classifier asks it the same question the line does: a fix that still belongs to the stand-by the
   * trace will collapse into one dot cannot be reported as travelling. Judged on the whole run, not
   * on a 90-second slice of it — which is why a parked phone's 25 m excursion in 40 s reads as a
   * place to the line and used to read as a walk to the state.
   *
   * `wanderCapS` is how long the stationary band is credited with wandering across the cluster. The
   * line leaves it open: a phone dozing for an hour reports its stand-by minutes apart, and the
   * collapse must not turn that silence into a route. The state's veto asks it capped — no rule in
   * §5 is measured over more than one evidence window, and a cluster that holds a *watched* 90 s of
   * real travel is not one the chip may be told to sit still for.
   */
  stayedPut(run: TraceRow[], wanderCapS = Infinity): boolean {
    const band = RULE_DEFAULTS.accuracyDriftM;
    const centre = meanOf(run);
    if (run.some((r) => this.geo.distanceM(centre, r) > band)) return false;
    if (run.length < 2) return true;
    const half = Math.ceil(run.length / 2);
    const netM = this.geo.distanceM(meanOf(run.slice(0, half)), meanOf(run.slice(half)));
    const spanS = (run[run.length - 1].clientTs.getTime() - run[0].clientTs.getTime()) / 1000;
    const accuracy = run.reduce((s, r) => s + (r.accuracyM ?? 0), 0) / run.length;
    const noiseRadiusM = Math.min(Math.max(accuracy, NOISE_FLOOR_M), band);
    const bubbleM = (MOTION.MOVED_CIRCLE_FACTOR * noiseRadiusM * Math.sqrt(2)) / Math.sqrt(Math.max(2, run.length));
    return netM <= Math.max(bubbleM, (MOTION.STATIONARY_SPEED_KMH / 3.6) * Math.min(Math.max(0, spanS), wanderCapS));
  }

  /** The one fix a stand-by reports: sitting at the middle of the cluster, stamped when it ended. */
  private stayPoint<T extends TraceRow>(run: T[]): T {
    const last = run[run.length - 1];
    if (run.length === 1) return last;
    const centre = meanOf(run);
    const medoid = run.reduce((best, r) => (this.geo.distanceM(centre, r) < this.geo.distanceM(centre, best) ? r : best), run[0]);
    return { ...last, lat: medoid.lat, lng: medoid.lng };
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
    return stops
      .map((s) => {
        const at = trace.find((t) => this.geo.distanceM(t, s) <= band);
        // Snapped onto the place the trace says he was — a stand-by day's seven stops are seven
        // readings of the same spot, not a fan of markers around it.
        return at ? { ...s, lat: at.lat, lng: at.lng } : null;
      })
      .filter((s): s is S => s !== null);
  }
}
