import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

/**
 * Dependency-free in-memory throttle: 10 login attempts / minute / identifier.
 * Good enough to blunt credential stuffing without extra packages.
 */
@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  private static readonly WINDOW_MS = 60_000;
  private static readonly MAX = 10;
  private readonly hits = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ body?: { identifier?: string }; ip?: string }>();
    const key = String(req.body?.identifier ?? req.ip ?? 'unknown').toLowerCase();
    const now = Date.now();
    const bucket = (this.hits.get(key) ?? []).filter((t) => now - t < LoginRateLimitGuard.WINDOW_MS);
    if (bucket.length >= LoginRateLimitGuard.MAX) {
      this.hits.set(key, bucket);
      throw new HttpException('LOGIN_RATE_LIMITED', HttpStatus.TOO_MANY_REQUESTS);
    }
    bucket.push(now);
    this.hits.set(key, bucket);
    // Opportunistic cleanup so the map cannot grow unbounded.
    if (this.hits.size > 5000) {
      for (const [k, arr] of this.hits) {
        const fresh = arr.filter((t) => now - t < LoginRateLimitGuard.WINDOW_MS);
        if (fresh.length === 0) this.hits.delete(k);
        else this.hits.set(k, fresh);
      }
    }
    return true;
  }

  /** Test helper to reset the sliding window. */
  reset(): void {
    this.hits.clear();
  }
}
