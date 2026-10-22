import { notificationLog, settings, mePreferences } from '../db';
import { busEmit } from '../bus';
import { err, ok } from '../util';
import type { MockRoute } from './auth';

export const settingsRoutes: MockRoute[] = [
  {
    method: 'GET',
    pattern: /^\/settings$/,
    handler: () => ok({ rules: settings, timezone: 'Africa/Cairo', notifications: notificationLog, preferences: mePreferences }),
  },
  {
    method: 'PATCH',
    pattern: /^\/settings$/,
    handler: ({ body }) => {
      Object.assign(settings, body.rules ?? body);
      return ok(settings);
    },
  },
  {
    method: 'GET',
    pattern: /^\/me\/preferences$/,
    handler: () => ok(mePreferences),
  },
  {
    method: 'PATCH',
    pattern: /^\/me\/preferences$/,
    handler: ({ body }) => {
      Object.assign(mePreferences, body);
      busEmit('notify:me', { title: 'تم تحديث التفضيلات', body: '', alertType: 'INFO' });
      return ok(mePreferences);
    },
  },
  {
    method: 'GET',
    pattern: /^\/notifications\/log$/,
    handler: () => ok({ log: [...notificationLog].sort((a, b) => b.at.localeCompare(a.at)) }),
  },
];
