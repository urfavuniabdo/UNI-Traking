import { Injectable } from '@nestjs/common';
import { MOTION, RULE_DEFAULTS } from '../../shared/constants';
import { bbox, lineString, simplify } from '@turf/turf';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { point as turfPoint, polygon } from '@turf/helpers';

/**
 * Tightest radius treated as "he did not move". A phone with 1 m accuracy still jitters a few
 * metres when parked, so the accuracy circle alone is not a floor.
 */
export const NOISE_FLOOR_M = 12;

export interface FenceShape {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  /** JSON string أو مصفوفة [[lat,lng],…] — يتجاوز الدائرة إن وُجد */
  polygon?: string | number[][] | null;
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** A fix with the two things a step needs to be judged: when it was taken and how far it could lie. */
export interface MeasuredStep extends LatLng {
  at: number;
  accuracyM?: number | null;
}

export interface FenceHit {
  fenceId: string;
  fenceName: string;
  inside: boolean;
  distanceToCenterM: number;
  kind: 'circle' | 'polygon';
}

const R = 6371008.8;
const toRad = (d: number) => (d * Math.PI) / 180;

@Injectable()
export class GeoService {
  /** مسافة Haversine بالمتر — بدون اعتماد على الامتدادات المكانية لقاعدة البيانات. */
  distanceM(a: LatLng, b: LatLng): number {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  bearingDeg(a: LatLng, b: LatLng): number {
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x =
      Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
      Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return (Math.atan2(y, x) * 180) / Math.PI < 0
      ? (Math.atan2(y, x) * 180) / Math.PI + 360
      : (Math.atan2(y, x) * 180) / Math.PI;
  }

  speedKmhBetween(a: LatLng & { at: number }, b: LatLng & { at: number }): number | null {
    const dt = (b.at - a.at) / 1000;
    if (!(dt > 0) || dt > 120) return null;
    return (this.distanceM(a, b) / dt) * 3.6;
  }

  /**
   * مسافة خطوة تدخل مجموع الأميال، أو صفر لو مش أرض مقطوعة فعلًا:
   * زمن راجع/صفرة = مسافة مش مُسندة، والسرعة اللازمة للخطوة لو بتتجاوز سقف المعقول
   * (نفس السقف اللي بيرفض بيه حارس القفزة الشاذة العينة) = قفزة GPS — نفق أو إعادة تثبيت
   * أو نقل بين موقعين. من غير الفلتر ده قفزة واحدة بتضيف عشرات الكيلومترات لتقرير اليوم.
   */
  credibleDistanceM(a: LatLng & { at: number }, b: LatLng & { at: number }): number {
    const dtS = (b.at - a.at) / 1000;
    if (!(dtS > 0)) return 0;
    const m = this.distanceM(a, b);
    return (m / dtS) * 3.6 > MOTION.MAX_CREDIBLE_SPEED_KMH ? 0 : m;
  }

  /**
   * المسافة اللي تُجمَّع كأرض مقطوعة: سقف `credibleDistanceM` ويز عليه فقاعة §5.
   * خطوة أقصر من `MOVED_CIRCLE_FACTOR × noiseRadiusM` المصنِّف برفضها أصلًا كسرعة — موبايل راكن
   * يترجّاع 15 م حوالين مكانه كل نص دقيقة — فممنوع تُجمَّع كيلو مترات. من غير الفلتر ده يوم سواق
   * «متوقف» من ساعة التشيك ان كان بيطلّع بالظبط نصف كم من اهتزاز الـ GPS، والخط بيقول راح وجا
   * والحالة بتقول قاعد. نفس الفقاعة اللي بيركبها `replayDay` على العينة الواحدة، بس على الخطوة.
   */
  groundDistanceM(a: MeasuredStep, b: MeasuredStep): number {
    const dtS = (b.at - a.at) / 1000;
    if (!(dtS > 0)) return 0;
    const m = this.distanceM(a, b);
    if ((m / dtS) * 3.6 > MOTION.MAX_CREDIBLE_SPEED_KMH) return 0;
    return m > this.movedCircleM(a, b) ? m : 0;
  }

  /** فقاعة الحركة لزوج نقاط: دقتان موزونتان، بأرضية سُمكها الطبيعي وسقف الـ drift بتاع §5. */
  movedCircleM(a: { accuracyM?: number | null }, b: { accuracyM?: number | null }): number {
    const accuracy = ((a.accuracyM ?? 0) + (b.accuracyM ?? 0)) / 2;
    const noiseRadiusM = Math.min(Math.max(accuracy, NOISE_FLOOR_M), RULE_DEFAULTS.accuracyDriftM);
    return MOTION.MOVED_CIRCLE_FACTOR * noiseRadiusM;
  }

  /** التسارع بـ m/s² من سرعتين (km/h) وفاصل زمني بالثواني. */
  accelerationMs2(vFromKmh: number, vToKmh: number, dtS: number): number | null {
    if (!(dtS > 0) || dtS > 30) return null;
    return (vToKmh - vFromKmh) / 3.6 / dtS;
  }

  /**
   * حلقة المضلع — الصيغة الموثقة في docs/CONTRACT.md هي [[lat,lng],…].
   * يُقبل أيضًا [[lng,lat],… (شكل GeoJSON): اتجاه الحلقة يتحدد بمطابقة مركزها مع
   * مركز النطاق المُعلَن (fence.lat/lng) — الأقرب هو الصحيح. بدون سحر: لو المركزين
   * على نفس المسافة تقريبًا نلتزم بصيغة العقد.
   */
  ringOf(fence: FenceShape): number[][] | null {
    if (!fence.polygon) return null;
    try {
      const raw =
        typeof fence.polygon === 'string' ? (JSON.parse(fence.polygon) as unknown) : fence.polygon;
      const arr = raw as unknown[];
      if (!Array.isArray(arr) || arr.length < 3) return null;
      const pairs = arr.map((item) => {
        if (Array.isArray(item) && item.length >= 2) return [Number(item[0]), Number(item[1])];
        const p = item as { lat?: number; lng?: number };
        return [Number(p.lat), Number(p.lng)];
      });
      if (!pairs.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
      if (pairs.some((p) => Math.abs(p[0]) > 90)) return pairs.map(([a, b]) => [b, a]);
      const mean = (i: 0 | 1) => pairs.reduce((s, p) => s + p[i], 0) / pairs.length;
      const center = { lat: fence.lat, lng: fence.lng };
      const asLatLng = this.distanceM(center, { lat: mean(0), lng: mean(1) });
      const asLngLat = this.distanceM(center, { lat: mean(1), lng: mean(0) });
      return asLngLat + 1 < asLatLng ? pairs.map(([a, b]) => [b, a]) : pairs;
    } catch {
      return null;
    }
  }

  /** [lat,lng] → [lng,lat] لاستدعاءات turf/GeoJSON. */
  private toTurfRing(ring: number[][]): number[][] {
    return ring.map(([lat, lng]) => [lng, lat]);
  }

  /** polygon عند وجوده وإلا دائرة radiusM حول النقطة. */
  test(fence: FenceShape, p: LatLng): FenceHit {
    const center = { lat: fence.lat, lng: fence.lng };
    const distanceToCenterM = Math.round(this.distanceM(center, p));
    const ring = this.ringOf(fence);
    if (ring) {
      const turfRing = this.toTurfRing(ring);
      const closed =
        turfRing[0][0] === turfRing[turfRing.length - 1][0] &&
        turfRing[0][1] === turfRing[turfRing.length - 1][1]
          ? turfRing
          : [...turfRing, turfRing[0]];
      const inside = booleanPointInPolygon(turfPoint([p.lng, p.lat]), polygon([closed]));
      return {
        fenceId: fence.id,
        fenceName: fence.name,
        inside,
        distanceToCenterM,
        kind: 'polygon',
      };
    }
    return {
      fenceId: fence.id,
      fenceName: fence.name,
      inside: distanceToCenterM <= fence.radiusM,
      distanceToCenterM,
      kind: 'circle',
    };
  }

  firstHit(fences: FenceShape[], p: LatLng): { hit?: FenceHit; hits: FenceHit[] } {
    const hits = fences.map((f) => this.test(f, p));
    return { hit: hits.find((h) => h.inside), hits };
  }

  /** تبسيط خط السير (Visvalingam) مع الاحتفاظ بالنقاط المتطرفة. toleranceM ≈ 15–40 م. */
  simplify(points: LatLng[], toleranceM = 25): LatLng[] {
    if (points.length < 3) return points;
    const coords = points.map((p) => [p.lng, p.lat]);
    if (new Set(coords.map((c) => c.join(','))).size < 3) return [points[0]];
    try {
      const line = lineString(coords);
      const tolDeg = toleranceM / 111_000;
      const out = simplify(line, { tolerance: tolDeg, highQuality: false });
      const s = out.geometry.coordinates;
      const uniq: LatLng[] = [];
      for (const [lng, lat] of s) {
        const last = uniq[uniq.length - 1];
        if (!last || last.lat !== lat || last.lng !== lng) uniq.push({ lat, lng });
      }
      return uniq.length >= 2 ? uniq : points.slice(0, 2);
    } catch {
      return points;
    }
  }

  geoJsonLine(points: LatLng[]): string {
    return JSON.stringify({
      type: 'LineString',
      coordinates: points.map((p) => [p.lng, p.lat]),
    });
  }

  fenceToGeoJSON(fence: FenceShape): string {
    const ring = this.ringOf(fence);
    if (ring) {
      const turfRing = this.toTurfRing(ring);
      const closed =
        turfRing[0][0] === turfRing[turfRing.length - 1][0]
          ? turfRing
          : [...turfRing, turfRing[0]];
      return JSON.stringify({ type: 'Polygon', coordinates: [closed] });
    }
    // تقريب دائرة إلى 64 ضلعًا للعرض على الخريطة
    const steps = 64;
    const coords: number[][] = [];
    const latRad = toRad(fence.lat);
    const dLat = fence.radiusM / 111_320;
    const dLng = fence.radiusM / (111_320 * Math.max(0.001, Math.cos(latRad)));
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * 2 * Math.PI;
      coords.push([fence.lng + dLng * Math.cos(t), fence.lat + dLat * Math.sin(t)]);
    }
    return JSON.stringify({ type: 'Polygon', coordinates: [coords] });
  }

  bboxOf(points: LatLng[]): [number, number, number, number] | null {
    if (!points.length) return null;
    try {
      const b = bbox(lineString(points.map((p) => [p.lng, p.lat])));
      return [b[0], b[1], b[2], b[3]];
    } catch {
      return null;
    }
  }
}
