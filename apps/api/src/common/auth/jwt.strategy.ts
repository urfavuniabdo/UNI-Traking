import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Role } from '../../shared/constants';
import { PrismaService } from '../prisma.service';

export interface JwtPayload {
  sub: string; // userId
  role: Role;
  employeeId?: string | null;
  name?: string;
  identifier?: string;
  scopeOrgUnitId?: string | null;
}

export interface AuthUser {
  id: string;
  role: Role;
  employeeId?: string | null;
  name?: string;
  identifier?: string;
  scopeOrgUnitId?: string | null;
}

const SCOPE_TTL_MS = 60_000;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private scopeCache = new Map<string, { value: string | null; at: number }>();

  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'dev-access-secret',
    });
  }

  /** التوكن لا يحمل نطاق الرقابة — نجيبه من الداتا بيز بكاش قصير العمر. */
  private async scopeOf(userId: string, fromPayload?: string | null): Promise<string | null> {
    if (fromPayload !== undefined) return fromPayload ?? null;
    const hit = this.scopeCache.get(userId);
    if (hit && Date.now() - hit.at < SCOPE_TTL_MS) return hit.value;
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { scopeOrgUnitId: true },
    });
    const value = row?.scopeOrgUnitId ?? null;
    this.scopeCache.set(userId, { value, at: Date.now() });
    return value;
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (!payload?.sub) throw new UnauthorizedException('BAD_TOKEN');
    return {
      id: payload.sub,
      role: payload.role,
      employeeId: payload.employeeId ?? null,
      name: payload.name,
      identifier: payload.identifier,
      scopeOrgUnitId: await this.scopeOf(payload.sub, payload.scopeOrgUnitId),
    };
  }
}
