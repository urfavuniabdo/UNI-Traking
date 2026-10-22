import { ROLES, type Role } from '@shared';

/** The dashboard is a supervisor tool: an employee or a driver works only through the app. */
export const DASHBOARD_ROLES: readonly Role[] = [ROLES.ADMIN, ROLES.SUPERVISOR, ROLES.HR];

/**
 * Which sidebar tabs a role is shown. `'*'` means "everything" — the IT admin's job is
 * diagnosis, so restricting him to a subset would only hide the thing he is called to see.
 * Anything not listed here is still refused by the API (§1); this is the honest mirror of that.
 */
const TABS: Record<Role, readonly string[]> = {
  [ROLES.ADMIN]: ['*'],
  [ROLES.SUPERVISOR]: ['/live', '/alerts', '/attendance', '/drivers', '/fences', '/reports', '/sync', '/settings'],
  [ROLES.HR]: ['/attendance', '/leave', '/reports', '/settings'],
  [ROLES.EMPLOYEE]: [],
  [ROLES.DRIVER]: [],
};

export const canSee = (role: Role | undefined, path: string): boolean => {
  if (!role) return false;
  const tabs = TABS[role] ?? [];
  return tabs.includes('*') || tabs.some((t) => path === t || path.startsWith(`${t}/`));
};

/** Where a role lands, and where a forbidden deep link sends him back to. */
export const homeFor = (role: Role | undefined): string => (role === ROLES.HR ? '/attendance' : '/live');

export const ROLE_LABEL_AR: Record<Role, string> = {
  [ROLES.ADMIN]: 'مدير النظام',
  [ROLES.SUPERVISOR]: 'مشرف المتابعة',
  [ROLES.HR]: 'مسؤول شؤون الموظفين',
  [ROLES.EMPLOYEE]: 'موظف',
  [ROLES.DRIVER]: 'سائق',
};

/**
 * The only `rules.global` keys an HR admin may send — mirrors `HR_RULE_KEYS` in
 * `apps/api/src/modules/rules/settings.service.ts`, which is the enforcer: any other key in a
 * PATCH from HR is a 403 FORBIDDEN_SETTING_KEY, so the form must not offer or submit one.
 */
export const HR_RULE_KEYS: readonly string[] = ['shiftGraceMin', 'attendanceStrictReject'];
