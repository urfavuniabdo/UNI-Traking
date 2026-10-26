import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

/**
 * `render.yaml` runs `prisma db push && ts-node prisma/seed.ts` on EVERY container start, so a seed
 * that updates rows it merely "knows the id of" undoes the operator's dashboard edits on the next
 * deploy — the zones he redrawn, the drivers he renamed, the roles he promoted. This spec runs the
 * real script twice against a temp DB and asserts the second run changes nothing that exists.
 */
const DB = 'file:../tmp-seed.db';
process.env.DATABASE_URL = DB;

jest.setTimeout(180_000);

const prisma = new PrismaClient();

const runSeed = (): void => {
  execSync('npx ts-node prisma/seed.ts', {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: DB },
    stdio: 'pipe',
  });
};

beforeAll(() => {
  try {
    rmSync('tmp-seed.db', { force: true });
    rmSync('tmp-seed.db-journal', { force: true });
  } catch {
    /* ignore */
  }
  execSync('npx prisma db push --skip-generate', {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: DB },
    stdio: 'pipe',
  });
  runSeed();
});

afterAll(async () => {
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
});

describe('prisma/seed.ts', () => {
  it('bootstraps an empty database with the org, logins and sites', async () => {
    expect(await prisma.orgUnit.count()).toBe(3);
    expect(await prisma.site.count()).toBe(2);
    expect(await prisma.employee.count()).toBe(14);
    expect(await prisma.user.count()).toBe(17);
    expect(await prisma.shiftAssignment.count()).toBe(14);
  });

  it('a second boot keeps what the operator edited and resurrects nothing', async () => {
    const mine = await prisma.zone.create({
      data: { code: 'MY-ZONE', name: 'منطقتي', orgUnitId: 'ou-cairo', lat: 30.11, lng: 31.22, radiusM: 900 },
    });
    await prisma.employee.update({ where: { id: 'emp-d0203' }, data: { name: 'وائل جمال', zoneId: mine.id } });
    await prisma.user.update({ where: { identifier: 'D0201' }, data: { role: 'SUPERVISOR' } });

    runSeed();

    expect(await prisma.zone.count()).toBe(1);
    expect(await prisma.zone.findFirstOrThrow({ where: { id: mine.id } })).toMatchObject({
      name: 'منطقتي',
      lat: 30.11,
      radiusM: 900,
    });
    const driver = await prisma.employee.findUniqueOrThrow({ where: { id: 'emp-d0203' } });
    expect(driver.name).toBe('وائل جمال');
    expect(driver.zoneId).toBe(mine.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { identifier: 'D0201' } })).role).toBe('SUPERVISOR');
  });
});
