import { CanActivate, ExecutionContext, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { request as nodeRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimitGuard } from './login-rate-limit.guard';
import { JwtAuthGuard } from '../../common/auth/guards';

// Permissive stand-in for the JWT guard: authenticates every request as u1.
class AllowGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: unknown }>();
    req.user = { id: 'u1', role: 'ADMIN' };
    return true;
  }
}

function post(
  path: string,
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = nodeRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('POST /auth/logout', () => {
  let app: INestApplication;
  let server: Server;
  let port: number;
  const logout = jest.fn().mockResolvedValue({ ok: true });
  const logoutByBearer = jest.fn().mockResolvedValue({ ok: true });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        LoginRateLimitGuard,
        { provide: AuthService, useValue: { logout, logoutByBearer } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(AllowGuard)
      .compile();

    app = moduleRef.createNestApplication();
    // Mirror main.ts validation so the DTO's @IsOptional() is exercised the same way.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, transformOptions: { enableImplicitConversion: true } }),
    );
    await app.init();
    // Bind an ephemeral port (never 3000) — getHttpServer() is the Express app.
    server = (app.getHttpServer() as unknown as { listen: (p: number) => Server }).listen(0);
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((res) => server?.close(() => res()));
    await app?.close();
  });

  beforeEach(() => {
    logout.mockClear();
    logoutByBearer.mockClear();
  });

  it('revokes the session from the refresh token alone — the app has no bearer left', async () => {
    const res = await post('/auth/logout', port, { refreshToken: 'rt-1' });
    expect(res.status).toBe(200);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledWith('rt-1');
    expect(logoutByBearer).not.toHaveBeenCalled();
  });

  it('still accepts the dashboard shape: empty `{}` body + bearer', async () => {
    const res = await post('/auth/logout', port, {}, { authorization: 'Bearer at-1' });
    expect(res.status).toBe(200);
    expect(logout).not.toHaveBeenCalled();
    expect(logoutByBearer).toHaveBeenCalledWith('Bearer at-1');
  });

  it('routes an empty body with no bearer to the bearer path, which decides', async () => {
    const res = await post('/auth/logout', port, {});
    expect(res.status).toBe(200);
    expect(logout).not.toHaveBeenCalled();
    expect(logoutByBearer).toHaveBeenCalledWith(undefined);
  });
});
