import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES } from '../../shared/constants';
import { RolesGuard, ROLES_KEY, Roles } from './guards';
import { AttendanceController } from '../../modules/attendance/attendance.controller';
import { ReportsController } from '../../modules/reports/reports.controller';
import { LeaveController } from '../../modules/leave/leave.controller';
import { EmployeesController } from '../../modules/employees/employees.controller';
import { PlacesController } from '../../modules/places/places.controller';
import { PositionsController } from '../../modules/tracking/positions.controller';
import { SettingsController } from '../../modules/rules/settings.controller';

const guard = new RolesGuard(new Reflector());

const ctxFor = (handler: (...args: never[]) => unknown, role: string): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', role } }) }),
  }) as unknown as ExecutionContext;

/** ADMIN + SUPERVISOR only — the tracking surface. */
class TrackingSurface {
  @Roles(ROLES.ADMIN, ROLES.SUPERVISOR)
  live(): void {}
}
/** Self-service paths carry no @Roles at all. */
class OpenSurface {
  me(): void {}
}

const reflector = new Reflector();
const rolesOf = (controller: { prototype: Record<string, Function> }, method: string): string[] =>
  (reflector.get<string[]>(ROLES_KEY, controller.prototype[method]) ?? []) as string[];

describe('RolesGuard — who sees what (CONTRACT §1)', () => {
  it('passes anyone on unguarded self-service paths', () => {
    expect(guard.canActivate(ctxFor(OpenSurface.prototype.me as never, ROLES.DRIVER))).toBe(true);
  });

  it('lets the listed roles through and answers FORBIDDEN_ROLE:<role> for the rest', () => {
    const hr = ctxFor(TrackingSurface.prototype.live as never, ROLES.HR);
    expect(() => guard.canActivate(hr)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(hr)).toThrow('FORBIDDEN_ROLE:HR');
    expect(guard.canActivate(ctxFor(TrackingSurface.prototype.live as never, ROLES.SUPERVISOR))).toBe(true);
  });

  it('the IT admin bypasses every roles list — he diagnoses everything', () => {
    expect(guard.canActivate(ctxFor(TrackingSurface.prototype.live as never, ROLES.ADMIN))).toBe(true);
    expect(guard.canActivate(ctxFor(LeaveController.prototype.list as never, ROLES.ADMIN))).toBe(true);
  });
});

describe('controller metadata — the HR split', () => {
  it('HR reads attendance, the org directory and the attendance-side reports', () => {
    for (const method of ['list', 'export']) expect(rolesOf(AttendanceController, method)).toContain(ROLES.HR);
    for (const method of ['orgTree', 'sites', 'zones']) expect(rolesOf(PlacesController, method)).toContain(ROLES.HR);
    for (const method of ['daily', 'timesheet', 'exceptions']) expect(rolesOf(ReportsController, method)).toContain(ROLES.HR);
    expect(rolesOf(EmployeesController, 'list')).toContain(ROLES.HR);
    expect(rolesOf(SettingsController, 'getSettings')).toContain(ROLES.HR);
    expect(rolesOf(SettingsController, 'patchSettings')).toContain(ROLES.HR);
  });

  it('HR is closed off trips, live tracking, the fence map and the alert log', () => {
    for (const method of ['route', 'mileage', 'liveKpis']) expect(rolesOf(ReportsController, method)).not.toContain(ROLES.HR);
    for (const method of ['live', 'presence']) expect(rolesOf(PositionsController, method)).not.toContain(ROLES.HR);
    expect(rolesOf(PlacesController, 'fences')).not.toContain(ROLES.HR);
    expect(rolesOf(PlacesController, 'geofenceCheck')).not.toContain(ROLES.HR);
    expect(rolesOf(EmployeesController, 'live')).not.toContain(ROLES.HR);
    expect(rolesOf(EmployeesController, 'one')).not.toContain(ROLES.HR);
    expect(rolesOf(SettingsController, 'notificationsLog')).not.toContain(ROLES.HR);
  });

  it('only HR and the IT admin can read or decide leave requests', () => {
    for (const method of ['list', 'approve', 'reject']) expect(rolesOf(LeaveController, method)).toEqual([ROLES.HR, ROLES.ADMIN]);
    // asking and tracking your own requests is every employee's own right
    expect(rolesOf(LeaveController, 'create')).toEqual([]);
    expect(rolesOf(LeaveController, 'mine')).toEqual([]);
    expect(rolesOf(LeaveController, 'cancel')).toEqual([]);
  });
});
