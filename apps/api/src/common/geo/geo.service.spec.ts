import { GeoService, FenceShape } from './geo.service';

const svc = new GeoService();
const base = (over: Partial<FenceShape> = {}): FenceShape => ({
  id: 'z1',
  name: 'Nasr City',
  lat: 30.06,
  lng: 31.33,
  radiusM: 8000,
  polygon: null,
  ...over,
});

describe('GeoService', () => {
  it('circle fence: inside by radius, outside beyond it', () => {
    expect(svc.test(base(), { lat: 30.065, lng: 31.331 }).inside).toBe(true);
    expect(svc.test(base(), { lat: 30.4, lng: 31.9 }).inside).toBe(false);
  });

  it('polygon given as [lat,lng] is evaluated correctly', () => {
    const f = base({
      polygon: JSON.stringify([
        [30.05, 31.32],
        [30.07, 31.32],
        [30.06, 31.34],
      ]),
    });
    expect(svc.test(f, { lat: 30.06, lng: 31.33 }).inside).toBe(true);
    expect(svc.test(f, { lat: 30.06, lng: 31.4 }).inside).toBe(false);
  });

  it('polygon given as GeoJSON [lng,lat] is auto-oriented against the declared center', () => {
    const f = base({
      polygon: JSON.stringify([
        [31.32, 30.05],
        [31.32, 30.07],
        [31.34, 30.06],
      ]),
    });
    expect(svc.ringOf(f)).toEqual([
      [30.05, 31.32],
      [30.07, 31.32],
      [30.06, 31.34],
    ]);
    expect(svc.test(f, { lat: 30.06, lng: 31.33 }).inside).toBe(true);
  });

  it('rejects malformed polygons instead of throwing', () => {
    expect(svc.ringOf(base({ polygon: 'not json' }))).toBeNull();
    expect(svc.ringOf(base({ polygon: JSON.stringify([[30, 31], [30.1, 31.1]]) }))).toBeNull();
    expect(svc.ringOf(base({ polygon: JSON.stringify([[30, 'x'], [31, 'y'], [32, 'z']]) }))).toBeNull();
  });

  it('distance and acceleration math', () => {
    expect(svc.distanceM({ lat: 30, lng: 31 }, { lat: 30.001, lng: 31 })).toBeCloseTo(111.2, 0);
    expect(svc.accelerationMs2(80, 20, 3)).toBeCloseTo(-5.56, 2);
    expect(svc.accelerationMs2(80, 20, 120)).toBeNull();
  });

  it('simplify keeps shape and collapses duplicates', () => {
    const line = Array.from({ length: 200 }, (_, i) => ({ lat: 30 + i * 0.0002, lng: 31.2 }));
    const out = svc.simplify(line, 25);
    expect(out.length).toBeLessThan(line.length);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(svc.simplify([{ lat: 30, lng: 31 }], 25)).toHaveLength(1);
  });

  it('fenceToGeoJSON emits [lng,lat] pairs for the dashboard map', () => {
    const gj = JSON.parse(svc.fenceToGeoJSON(base({ polygon: JSON.stringify([[30.05, 31.32], [30.07, 31.32], [30.06, 31.34]]) })));
    expect(gj.type).toBe('Polygon');
    expect(gj.coordinates[0][0]).toEqual([31.32, 30.05]);
    const circle = JSON.parse(svc.fenceToGeoJSON(base()));
    expect(circle.coordinates[0]).toHaveLength(65);
  });
});
