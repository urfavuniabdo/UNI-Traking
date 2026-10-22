import { Inject, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { Role } from '../../shared/constants';
import { ROLES } from '../../shared/constants';
import type { LivePosition, RealtimePublisher } from '../../common/contracts';

interface RtAuthUser {
  id: string;
  role: Role;
  employeeId?: string | null;
  name?: string;
}

/**
 * Realtime namespace `/rt`.
 *  - Authenticates the handshake with the same JWT secret as the HTTP layer.
 *  - Organises sockets into rooms: `role:<ROLE>`, `watch:admins` (ADMIN+SUPERVISOR), `user:<id>`.
 *  - Implements `RealtimePublisher` so business modules can broadcast without importing this class
 *    (broadcast is fire-and-forget and must NEVER throw into business code).
 */
@WebSocketGateway({
  namespace: '/rt',
  cors: { origin: (process.env.CORS_ORIGINS ?? '*').split(','), credentials: true },
})
export class SocketGateway implements RealtimePublisher, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(SocketGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(@Inject(JwtService) private readonly jwt: JwtService) {}

  handleConnection(client: Socket): void {
    try {
      const token =
        (client.handshake.auth && (client.handshake.auth.token as string)) ||
        (client.handshake.query && (client.handshake.query.token as string)) ||
        this.fromBearer(client.handshake.headers.authorization);
      if (!token) {
        client.emit('rt:error', { code: 'NO_TOKEN' });
        client.disconnect(true);
        return;
      }
      const payload = this.jwt.verify<RtAuthUser & { sub: string }>(token, {
        secret: process.env.JWT_SECRET || 'dev-access-secret',
      });
      const user: RtAuthUser = {
        id: payload.sub,
        role: payload.role,
        employeeId: payload.employeeId ?? null,
        name: payload.name,
      };
      (client.data as { user?: RtAuthUser }).user = user;
      client.join(`role:${user.role}`);
      if (user.role === ROLES.ADMIN || user.role === ROLES.SUPERVISOR) client.join('watch:admins');
      client.join(`user:${user.id}`);
      client.emit('rt:ready', { userId: user.id, role: user.role });
    } catch (err) {
      this.logger.debug(`rt auth rejected: ${(err as Error)?.message}`);
      client.emit('rt:error', { code: 'BAD_TOKEN' });
      client.disconnect(true);
    }
  }

  handleDisconnect(_client: Socket): void {
    /* rooms are cleaned up automatically by socket.io */
  }

  /**
   * Live/route rooms a socket may join. ADMIN + SUPERVISOR watch anyone; every other role
   * only itself — otherwise an app user (or an HR account) could subscribe to another
   * driver's position stream straight through the namespace, past the HTTP role guards.
   */
  private watchableRooms(client: Socket, userIds: string[], prefix: string): string[] {
    const user = (client.data as { user?: RtAuthUser }).user;
    if (!user) return [];
    const privileged = user.role === ROLES.ADMIN || user.role === ROLES.SUPERVISOR;
    const own = new Set([user.id, user.employeeId ?? '']);
    return (privileged ? userIds : userIds.filter((id) => own.has(id))).map((id) => `${prefix}:${id}`);
  }

  @SubscribeMessage('subscribe:live')
  onSubscribeLive(client: Socket, payload: { userIds?: string[] } = {}): { ok: boolean; rooms: string[] } {
    const rooms = this.watchableRooms(client, payload?.userIds ?? [], 'watch:live');
    for (const r of rooms) client.join(r);
    return { ok: true, rooms };
  }

  @SubscribeMessage('subscribe:route')
  onSubscribeRoute(client: Socket, payload: { userIds?: string[] } = {}): { ok: boolean; rooms: string[] } {
    const rooms = this.watchableRooms(client, payload?.userIds ?? [], 'watch:route');
    for (const r of rooms) client.join(r);
    return { ok: true, rooms };
  }

  // ---- RealtimePublisher (fire-and-forget, never throws) ----

  position(p: LivePosition): void {
    // Live key is the employee id (dashboard cards); the driver's own socket sits in
    // user:<authUserId>, so route to both or the app stops seeing its own positions.
    const rooms = ['watch:admins', `watch:live:${p.userId}`, `user:${p.userId}`];
    if (p.authUserId) rooms.push(`user:${p.authUserId}`, `watch:live:${p.authUserId}`);
    this.safeEmit('position:update', p, rooms);
  }

  alert(alertPayload: unknown, audience: { userIds: string[]; roles: Role[] }): void {
    const rooms = new Set<string>();
    if (audience.roles?.includes(ROLES.ADMIN) || audience.roles?.includes(ROLES.SUPERVISOR)) {
      rooms.add('watch:admins');
    }
    for (const role of audience.roles ?? []) rooms.add(`role:${role}`);
    for (const uid of audience.userIds ?? []) rooms.add(`user:${uid}`);
    // alert:new goes to everyone interested; notify:me only to the subject user.
    this.safeEmit('alert:new', alertPayload, [...rooms]);
    for (const uid of audience.userIds ?? []) {
      const subject = alertPayload as { title?: string; body?: string; type?: string };
      this.safeEmit('notify:me', { title: subject.title, body: subject.body, alertType: subject.type }, [`user:${uid}`]);
    }
  }

  attendance(p: { userId: string; kind: 'IN' | 'OUT'; status: string; ts: string }): void {
    this.safeEmit('attendance:changed', p, ['watch:admins', `user:${p.userId}`]);
  }

  presence(p: { userId: string; online: boolean; tracking: boolean; gpsEnabled: boolean; lastSeen: string }): void {
    this.safeEmit('driver:presence', p, ['watch:admins', `user:${p.userId}`]);
  }

  /** Emit an arbitrary event to a set of rooms — used for alert:updated and by tests. */
  publish(event: string, payload: unknown, rooms: string[]): void {
    this.safeEmit(event, payload, rooms);
  }

  private safeEmit(event: string, payload: unknown, rooms: string[]): void {
    try {
      if (!this.server) return; // gateway not bound (e.g. unit tests) → drop silently
      if (!rooms.length) return;
      this.server.to(rooms).emit(event, payload);
    } catch (err) {
      this.logger.warn(`rt emit failed for ${event}: ${(err as Error)?.message}`);
    }
  }

  private fromBearer(header?: string): string | null {
    if (!header) return null;
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return m ? m[1] : null;
  }
}
