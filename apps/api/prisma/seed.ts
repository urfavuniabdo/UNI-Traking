/* Deterministic, idempotent dev seed — safe to run repeatedly (all upserts). */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { normalizePhone } from '../src/common/utils';

/** Minimal, dependency-free .env loader (Prisma's runtime client does not read .env itself). */
function loadEnv() {
  for (const rel of ['../.env', '../../.env', '../../../.env']) {
    const file = resolve(__dirname, rel);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
}
loadEnv();

const prisma = new PrismaClient();
const INIT_PASSWORD = process.env.ADMIN_INIT_PASSWORD || 'ChangeMe123!';
const PW_HASH = bcrypt.hashSync(INIT_PASSWORD, 10);

const ou = { id: 'ou-hq', code: 'HQ', name: 'Uni Group HQ' };
const ouCairo = { id: 'ou-cairo', code: 'CAIRO_OPS', name: 'Cairo Operations', parentId: ou.id };
const ouAlex = { id: 'ou-alex', code: 'ALEX_OPS', name: 'Alexandria Operations', parentId: ou.id };

const sites = [
  { id: 'site-cairo', code: 'CAIRO', name: 'Cairo HQ', orgUnitId: ouCairo.id, lat: 30.0444, lng: 31.2357, radiusM: 250, strictReject: false },
  { id: 'site-alex', code: 'ALEX', name: 'Alexandria Depot', orgUnitId: ouAlex.id, lat: 31.2001, lng: 29.9187, radiusM: 300, strictReject: false },
];

const zones = [
  { id: 'zone-nasr', code: 'NASR', name: 'Nasr City', orgUnitId: ouCairo.id, lat: 30.06, lng: 31.33, radiusM: 6000, maxSpeedKmh: 70, stopAlertMin: 30 },
  { id: 'zone-helwan', code: 'HELWAN', name: 'Helwan', orgUnitId: ouCairo.id, lat: 29.864, lng: 31.346, radiusM: 6000, maxSpeedKmh: 80, stopAlertMin: 45 },
  { id: 'zone-maadi', code: 'MAADI', name: 'Maadi', orgUnitId: ouCairo.id, lat: 30.007, lng: 31.25, radiusM: 5000, maxSpeedKmh: 60, stopAlertMin: 30 },
];

const schedules = [
  { id: 'sched-day', code: 'DAY', name: 'Day shift', startMinDay: 480, endMinDay: 1080, crossMidnight: false, graceMin: 30 },
  { id: 'sched-night', code: 'NIGHT', name: 'Night shift', startMinDay: 1200, endMinDay: 360, crossMidnight: true, graceMin: 30 },
];

type Emp = { id: string; externalId: string; name: string; phone: string; siteId?: string; zoneId?: string; orgUnitId: string; jobTitle?: string };

const employees: Emp[] = [
  { id: 'emp-e0101', externalId: 'E0101', name: 'Ahmed Ali', phone: '01000000101', siteId: 'site-cairo', orgUnitId: ouCairo.id, jobTitle: 'Accountant' },
  { id: 'emp-e0102', externalId: 'E0102', name: 'Mona Farid', phone: '01000000102', siteId: 'site-cairo', orgUnitId: ouCairo.id, jobTitle: 'HR Officer' },
  { id: 'emp-e0103', externalId: 'E0103', name: 'Karim Adel', phone: '01000000103', siteId: 'site-cairo', orgUnitId: ouCairo.id, jobTitle: 'IT Support' },
  { id: 'emp-e0104', externalId: 'E0104', name: 'Hala Sabry', phone: '01000000104', siteId: 'site-alex', orgUnitId: ouAlex.id, jobTitle: 'Storekeeper' },
  { id: 'emp-e0105', externalId: 'E0105', name: 'Tarek Nabil', phone: '01000000105', siteId: 'site-alex', orgUnitId: ouAlex.id, jobTitle: 'Receptionist' },
  { id: 'emp-e0106', externalId: 'E0106', name: 'Nour Hamdy', phone: '01000000106', siteId: 'site-cairo', orgUnitId: ouCairo.id, jobTitle: 'Sales' },
  { id: 'emp-e0107', externalId: 'E0107', name: 'Rana Fathy', phone: '01000000107', siteId: 'site-cairo', orgUnitId: ouCairo.id, jobTitle: 'Finance' },
  { id: 'emp-e0108', externalId: 'E0108', name: 'Bassel Omar', phone: '01000000108', siteId: 'site-alex', orgUnitId: ouAlex.id, jobTitle: 'Logistics' },
];

const drivers: Emp[] = [
  { id: 'emp-d0201', externalId: 'D0201', name: 'Mostafa Amin', phone: '01000000201', zoneId: 'zone-nasr', orgUnitId: ouCairo.id },
  { id: 'emp-d0202', externalId: 'D0202', name: 'Islam Shedid', phone: '01000000202', zoneId: 'zone-helwan', orgUnitId: ouCairo.id },
  { id: 'emp-d0203', externalId: 'D0203', name: 'Wael Gamal', phone: '01000000203', zoneId: 'zone-maadi', orgUnitId: ouCairo.id },
  { id: 'emp-d0204', externalId: 'D0204', name: 'Hamdy Sobhy', phone: '01000000204', zoneId: 'zone-nasr', orgUnitId: ouCairo.id },
  { id: 'emp-d0205', externalId: 'D0205', name: 'Sayed Refaie', phone: '01000000205', zoneId: 'zone-helwan', orgUnitId: ouCairo.id },
  { id: 'emp-d0206', externalId: 'D0206', name: 'Adel Marzouk', phone: '01000000206', zoneId: 'zone-maadi', orgUnitId: ouCairo.id },
];

async function main() {
  // Org units
  await prisma.orgUnit.upsert({ where: { id: ou.id }, update: { code: ou.code, name: ou.name }, create: ou });
  await prisma.orgUnit.upsert({ where: { id: ouCairo.id }, update: ouCairo, create: ouCairo });
  await prisma.orgUnit.upsert({ where: { id: ouAlex.id }, update: ouAlex, create: ouAlex });

  // Sites
  for (const s of sites) {
    await prisma.site.upsert({ where: { id: s.id }, update: s, create: { ...s, polygon: null, active: true } });
  }

  // Zones
  for (const z of zones) {
    await prisma.zone.upsert({ where: { id: z.id }, update: z, create: { ...z, polygon: null, active: true } });
  }

  // Shift schedules
  for (const s of schedules) {
    await prisma.shiftSchedule.upsert({ where: { id: s.id }, update: s, create: s });
  }

  // Employees (8) — kind EMPLOYEE
  for (const e of employees) {
    const phone = normalizePhone(e.phone) ?? e.phone;
    await prisma.employee.upsert({
      where: { id: e.id },
      update: { name: e.name, phone, siteId: e.siteId ?? null, orgUnitId: e.orgUnitId, jobTitle: e.jobTitle ?? null, kind: 'EMPLOYEE', source: 'MANUAL' },
      create: { id: e.id, externalId: e.externalId, name: e.name, phone, email: `${e.externalId.toLowerCase()}@uni-group.example`, siteId: e.siteId ?? null, orgUnitId: e.orgUnitId, jobTitle: e.jobTitle ?? null, kind: 'EMPLOYEE', source: 'MANUAL', active: true },
    });
    // login for the employee (identifier = externalId, must change temp password)
    await prisma.user.upsert({
      where: { identifier: e.externalId },
      update: { name: e.name, role: 'EMPLOYEE', employeeId: e.id },
      create: { identifier: e.externalId, name: e.name, role: 'EMPLOYEE', passwordHash: PW_HASH, mustChangePassword: true, employeeId: e.id },
    });
    // day shift assignment (daily, weekday null)
    await upsertShift(e.id, 'sched-day', null);
  }

  // Drivers (6) — kind DRIVER
  for (const d of drivers) {
    const phone = normalizePhone(d.phone) ?? d.phone;
    await prisma.employee.upsert({
      where: { id: d.id },
      update: { name: d.name, phone, zoneId: d.zoneId ?? null, orgUnitId: d.orgUnitId, kind: 'DRIVER', source: 'MANUAL' },
      create: { id: d.id, externalId: d.externalId, name: d.name, phone, zoneId: d.zoneId ?? null, orgUnitId: d.orgUnitId, kind: 'DRIVER', source: 'MANUAL', active: true },
    });
    await prisma.user.upsert({
      where: { identifier: d.externalId },
      update: { name: d.name, role: 'DRIVER', employeeId: d.id },
      create: { identifier: d.externalId, name: d.name, role: 'DRIVER', passwordHash: PW_HASH, mustChangePassword: true, employeeId: d.id },
    });
    await upsertShift(d.id, 'sched-night', null);
  }

  // Admin + supervisor accounts
  await prisma.user.upsert({
    where: { identifier: 'admin' },
    update: { name: 'System Administrator', role: 'ADMIN', scopeOrgUnitId: ou.id },
    create: { identifier: 'admin', name: 'System Administrator', role: 'ADMIN', passwordHash: PW_HASH, mustChangePassword: true, scopeOrgUnitId: ou.id },
  });
  await prisma.user.upsert({
    where: { identifier: 'supervisor' },
    update: { name: 'Ops Supervisor', role: 'SUPERVISOR', scopeOrgUnitId: ouCairo.id },
    create: { identifier: 'supervisor', name: 'Ops Supervisor', role: 'SUPERVISOR', passwordHash: PW_HASH, mustChangePassword: true, scopeOrgUnitId: ouCairo.id },
  });
  // HR owns attendance + leave approvals; it never sees trips or live tracking.
  await prisma.user.upsert({
    where: { identifier: 'hr' },
    update: { name: 'HR Manager', role: 'HR', scopeOrgUnitId: ou.id },
    create: { identifier: 'hr', name: 'HR Manager', role: 'HR', passwordHash: PW_HASH, mustChangePassword: true, scopeOrgUnitId: ou.id },
  });

  // Sync source (CSV master) — the sync agent owns import; this row + sample CSV are the contract target.
  await prisma.syncSource.upsert({
    where: { code: 'MASTER_CSV' },
    update: { kind: 'csv', config: JSON.stringify({ path: '../../_data/employees.sample.csv', delimiter: ',' }) },
    create: {
      code: 'MASTER_CSV',
      name: 'HR Master (CSV)',
      kind: 'csv',
      config: JSON.stringify({ path: '../../_data/employees.sample.csv', delimiter: ',' }),
      scheduleCron: process.env.SYNC_CRON ?? '0 */15 * * * *',
      enabled: true,
    },
  });

  const counts = {
    orgUnits: await prisma.orgUnit.count(),
    sites: await prisma.site.count(),
    zones: await prisma.zone.count(),
    employees: await prisma.employee.count(),
    users: await prisma.user.count(),
    schedules: await prisma.shiftSchedule.count(),
    shiftAssignments: await prisma.shiftAssignment.count(),
    syncSources: await prisma.syncSource.count(),
    leaveRequests: await prisma.leaveRequest.count(),
  };
  // eslint-disable-next-line no-console
  console.log('seed complete:', counts);
}

async function upsertShift(employeeId: string, scheduleId: string, weekday: number | null) {
  const found = await prisma.shiftAssignment.findFirst({ where: { employeeId, scheduleId, weekday: weekday as never } });
  if (!found) {
    await prisma.shiftAssignment.create({ data: { employeeId, scheduleId, weekday } });
  }
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('seed failed', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
