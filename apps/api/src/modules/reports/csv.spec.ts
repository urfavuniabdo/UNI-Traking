import { toCsv, tabular } from './csv';

describe('CSV escaping (CONTRACT §9, Arabic-safe)', () => {
  it('starts with a UTF-8 BOM so Excel renders Arabic correctly', () => {
    const out = toCsv(['driver'], [['سائق']]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
  });

  it('quotes cells containing commas and doubles inner quotes', () => {
    const out = toCsv(['a', 'b'], [['x,y', 'say "hi"']]);
    const [header, row] = out.replace('﻿', '').split('\r\n');
    expect(header).toBe('a,b');
    expect(row).toBe('"x,y","say ""hi"""');
  });

  it('preserves Arabic text and quotes newline cells', () => {
    const out = toCsv(['التنبيه'], [['تجاوز السرعة,\nالحد المسموح']]);
    expect(out).toContain('"تجاوز السرعة,\nالحد المسموح"');
  });

  it('renders null/undefined as empty cells', () => {
    const out = toCsv(['h'], [[null, undefined, 5]]);
    expect(out.replace('﻿', '').split('\r\n')[1]).toBe(',,5');
  });

  it('tabular() builds headers, rows and JSON objects from column specs', () => {
    const rows = [
      { name: 'أحمد', km: 12.5 },
      { name: 'علي, الإبن', km: 3 },
    ];
    const t = tabular(
      [
        { label: 'driver', get: (r: (typeof rows)[number]) => r.name },
        { label: 'distanceKm', get: (r: (typeof rows)[number]) => r.km },
      ],
      rows,
    );
    expect(t.headers).toEqual(['driver', 'distanceKm']);
    expect(t.rows[1]).toEqual(['علي, الإبن', 3]);
    const csv = toCsv(t.headers, t.rows);
    expect(csv).toContain('"علي, الإبن",3');
  });
});
