import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { createHash, randomUUID } from 'crypto';
import type { Role } from '../../shared/constants';
import { PrismaService } from '../../common/prisma.service';
import type { JwtPayload } from '../../common/auth/jwt.strategy';

export interface AuthUserDto {
  id: string;
  identifier: string;
  name: string;
  role: Role;
  employeeId: string | null;
  phone: string | null;
  siteId?: string | null;
  zoneId?: string | null;
  driver: boolean;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '30d';
const JWT_SECRET = () => process.env.JWT_SECRET || 'dev-access-secret';
const JWT_REFRESH_SECRET = () => process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret';

/** Convert '15m' / '30d' / '12h' / '45s' to milliseconds. */
export const ttlToMs = (ttl: string): number => {
  const m = /^(\d+)\s*([smhd])?$/.exec(String(ttl).trim());
  if (!m) return 15 * 60 * 1000;
  const n = Number(m[1]);
  const unit = m[2] ?? 's';
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
};

const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** Find the User matching an identifier (login id) OR an employee email that owns a user. */
  private async resolveUser(identifier: string) {
    const id = identifier.trim();
    return this.prisma.user.findFirst({
      where: {
        OR: [{ identifier: id }, { employee: { email: id } }],
      },
      include: { employee: true },
    });
  }

  async login(identifier: string, password: string) {
    const user = await this.resolveUser(identifier);
    if (!user) throw new UnauthorizedException('INVALID_CREDENTIALS');
    if (user.disabled) throw new ForbiddenException('ACCOUNT_DISABLED');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('INVALID_CREDENTIALS');

    const tokens = await this.issueSession(user);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      ...tokens,
      user: await this.toUserDto(user),
      mustChangePassword: user.mustChangePassword,
      changeOnLogin: user.mustChangePassword,
    };
  }

  async refresh(refreshToken: string) {
    let decoded: { sub: string; sid: string };
    try {
      decoded = await this.jwt.verifyAsync(refreshToken, { secret: JWT_REFRESH_SECRET() });
    } catch {
      throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
    }
    if (!decoded?.sid || !decoded?.sub) throw new UnauthorizedException('INVALID_REFRESH_TOKEN');

    const session = await this.prisma.session.findUnique({ where: { id: decoded.sid } });
    if (!session || session.userId !== decoded.sub || session.expiresAt < new Date()) {
      throw new UnauthorizedException('REFRESH_EXPIRED');
    }
    if (session.revokedAt) throw new UnauthorizedException('REFRESH_EXPIRED');
    if (session.refreshTokenHash !== hashToken(refreshToken)) {
      throw new UnauthorizedException('REFRESH_EXPIRED');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.userId },
      include: { employee: true },
    });
    if (!user || user.disabled) throw new UnauthorizedException('ACCOUNT_DISABLED');

    // The mobile app runs several isolates (UI, tracking service, WorkManager catch-up), each
    // with its own in-memory copy of the stored token. Rotating here made the second isolate
    // present the token the first one had just replaced, which read as theft and revoked the
    // driver's whole session mid-shift. So a refresh mints a new ACCESS token and slides the
    // session's expiry, but the refresh token itself stays the one this session was issued —
    // it is still only ever revoked by an explicit logout (or the 30-day idle window).
    const accessToken = await this.mintAccessToken(user);
    await this.prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() + ttlToMs(REFRESH_TTL)) },
    });
    return {
      accessToken,
      refreshToken,
      user: await this.toUserDto(user),
      mustChangePassword: user.mustChangePassword,
      changeOnLogin: user.mustChangePassword,
    };
  }

  async logout(refreshToken: string) {
    const decoded = await this.jwt
      .verifyAsync<{ sid?: string }>(refreshToken, { secret: JWT_REFRESH_SECRET() })
      .catch(() => null);
    if (decoded?.sid) {
      await this.prisma.session
        .update({ where: { id: decoded.sid }, data: { revokedAt: new Date() } })
        .catch(() => undefined);
    }
    const hash = hashToken(refreshToken);
    await this.prisma.session.updateMany({ where: { refreshTokenHash: hash, revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  /**
   * The dashboard's sign-out: no refresh token in the body, so the bearer identifies the user
   * and every one of their live sessions is revoked. Verified here rather than by a guard
   * because this route is public — the mobile app has already dropped its tokens by the time it
   * calls, and proves ownership with the refresh token instead.
   */
  async logoutByBearer(authorization?: string) {
    const raw = String(authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!raw) throw new UnauthorizedException('INVALID_REFRESH_TOKEN');
    const decoded = await this.jwt
      .verifyAsync<{ sub?: string }>(raw, { secret: JWT_SECRET() })
      .catch(() => null);
    if (!decoded?.sub) throw new UnauthorizedException('UNAUTHENTICATED');
    await this.prisma.session.updateMany({
      where: { userId: decoded.sub, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  /** Effective permissions per CONTRACT §1. */
  permissionsFor(role: Role): string[] {
    const base = ['auth:me', 'attendance:self', 'devices:self'];
    if (role === 'ADMIN') {
      return [
        ...base,
        'employees:read', 'employees:write', 'users:read', 'users:write',
        'places:read', 'places:write', 'attendance:read', 'attendance:export',
        'devices:read', 'devices:write', 'rules:write', 'sync:run',
        'alerts:read', 'alerts:ack', 'alerts:resolve', 'reports:read',
        'leave:read', 'leave:decide',
      ];
    }
    if (role === 'SUPERVISOR') {
      return [
        ...base,
        'employees:read', 'places:read', 'attendance:read', 'attendance:export',
        'devices:read', 'alerts:read', 'alerts:ack', 'alerts:resolve', 'reports:read',
      ];
    }
    // HR: attendance, departments and leave only — no alerts, no devices, no tracking reports.
    if (role === 'HR') {
      return [
        ...base,
        'employees:read', 'places:read', 'attendance:read', 'attendance:export',
        'reports:read', 'rules:write', 'leave:read', 'leave:decide',
      ];
    }
    return base;
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { employee: { select: { id: true, externalId: true, name: true, kind: true, phone: true, siteId: true, zoneId: true, jobTitle: true } } },
    });
    if (!user) throw new UnauthorizedException('UNAUTHENTICATED');
    return {
      user: await this.toUserDto(user),
      profile: user.employee ?? null,
      permissions: this.permissionsFor(user.role as Role),
      mustChangePassword: user.mustChangePassword,
      scopeOrgUnitId: user.scopeOrgUnitId ?? null,
    };
  }

  async changePassword(userId: string, currentPassword: string | undefined, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('UNAUTHENTICATED');
    if (!user.mustChangePassword) {
      if (!currentPassword) throw new BadRequestException('CURRENT_PASSWORD_REQUIRED');
      if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
        throw new UnauthorizedException('INVALID_CREDENTIALS');
      }
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });
    // Changing the password invalidates all existing sessions.
    await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: true };
  }

  private async mintTokens(
    user: { id: string; identifier: string; name: string; role: string; employeeId?: string | null },
    sid: string,
  ): Promise<TokenPair> {
    const accessToken = await this.mintAccessToken(user);
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, sid, kind: 'refresh', jti: randomUUID() },
      { secret: JWT_REFRESH_SECRET(), expiresIn: REFRESH_TTL },
    );
    return { accessToken, refreshToken };
  }

  private async mintAccessToken(
    user: { id: string; identifier: string; name: string; role: string; employeeId?: string | null },
  ): Promise<string> {
    const payload: JwtPayload = {
      sub: user.id,
      role: user.role as Role,
      employeeId: user.employeeId ?? null,
      name: user.name,
      identifier: user.identifier,
    };
    return this.jwt.signAsync(payload, { secret: JWT_SECRET(), expiresIn: ACCESS_TTL });
  }

  private async issueSession(user: {
    id: string;
    identifier: string;
    name: string;
    role: string;
    employeeId?: string | null;
  }): Promise<TokenPair> {
    const sid = randomUUID();
    const pair = await this.mintTokens(user, sid);
    await this.prisma.session.create({
      data: {
        id: sid,
        userId: user.id,
        refreshTokenHash: hashToken(pair.refreshToken),
        expiresAt: new Date(Date.now() + ttlToMs(REFRESH_TTL)),
      },
    });
    return pair;
  }

  private toUserDto(user: {
    id: string;
    identifier: string;
    name: string;
    role: string;
    employeeId?: string | null;
    employee?: { id?: string; phone: string; siteId?: string | null; zoneId?: string | null; kind?: string } | null;
  }): AuthUserDto {
    const emp = user.employee ?? null;
    return {
      id: user.id,
      identifier: user.identifier,
      name: user.name,
      role: user.role as Role,
      employeeId: user.employeeId ?? emp?.id ?? null,
      phone: emp?.phone ?? null,
      siteId: emp?.siteId ?? null,
      zoneId: emp?.zoneId ?? null,
      driver: (emp?.kind ?? user.role) === 'DRIVER',
    };
  }
}
