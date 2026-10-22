import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Role } from '../../shared/constants';

export interface JwtPayload {
  sub: string; // userId
  role: Role;
  employeeId?: string | null;
  name?: string;
  identifier?: string;
}

export interface AuthUser {
  id: string;
  role: Role;
  employeeId?: string | null;
  name?: string;
  identifier?: string;
  scopeOrgUnitId?: string | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'dev-access-secret',
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    if (!payload?.sub) throw new UnauthorizedException('BAD_TOKEN');
    return {
      id: payload.sub,
      role: payload.role,
      employeeId: payload.employeeId ?? null,
      name: payload.name,
      identifier: payload.identifier,
    };
  }
}
