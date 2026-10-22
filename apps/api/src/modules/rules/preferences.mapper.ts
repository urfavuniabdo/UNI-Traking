import { ALERT_TYPES, type AlertType } from '../../shared/constants';

/**
 * The flat notification-preference shape the dashboard's Settings page reads
 * (`apps/dashboard/src/pages/Settings.tsx`). It is translated to/from the frozen
 * `UserPreference` string-keyed rows on the controller/service boundary — no schema change.
 *
 * Storage keys (String columns):
 *   push.enabled     'true' | 'false'   → push      (default true: !== 'false')
 *   notify.whatsapp  'true' | 'false'   → whatsapp  (default true)
 *   notify.email     'true' | 'false'   → email     (default true)
 *   notify.sound     'true' | 'false'   → sound     (default true)
 *   push.mutedTypes  CSV of AlertType    → types = ALERT_TYPES \ mutedTypes
 */
export interface FlatPrefs {
  push: boolean;
  whatsapp: boolean;
  email: boolean;
  sound: boolean;
  types: AlertType[];
}

export type PrefKey = keyof FlatPrefs;

/** Stored string → boolean, defaulting to true unless explicitly 'false'. */
const boolOrTrue = (v: string | undefined): boolean => v !== 'false';

const splitCsv = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Build the flat prefs object from the caller's raw key/value rows. */
export const prefsFromRows = (rows: Array<{ key: string; value: string }>): FlatPrefs => {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const muted = new Set(splitCsv(map.get('push.mutedTypes')));
  return {
    push: boolOrTrue(map.get('push.enabled')),
    whatsapp: boolOrTrue(map.get('notify.whatsapp')),
    email: boolOrTrue(map.get('notify.email')),
    sound: boolOrTrue(map.get('notify.sound')),
    types: ALERT_TYPES.filter((t) => !muted.has(t)),
  };
};

/**
 * Translate a PATCH body (flat names, partial allowed) into the string-keyed columns to upsert.
 * Unknown keys are ignored here so the store stays clean; booleans are coerced with !!.
 */
export const flatPatchToRows = (
  patch: Record<string, unknown>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  if (patch.push !== undefined) out['push.enabled'] = String(Boolean(patch.push));
  if (patch.whatsapp !== undefined) out['notify.whatsapp'] = String(Boolean(patch.whatsapp));
  if (patch.email !== undefined) out['notify.email'] = String(Boolean(patch.email));
  if (patch.sound !== undefined) out['notify.sound'] = String(Boolean(patch.sound));
  if (Array.isArray(patch.types)) {
    const wanted = new Set(patch.types as readonly string[]);
    out['push.mutedTypes'] = ALERT_TYPES.filter((t) => !wanted.has(t)).join(',');
  }
  return out;
};
