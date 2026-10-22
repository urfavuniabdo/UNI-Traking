import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ALERT_DISPATCHER, REALTIME_PUBLISHER } from '../../common/contracts';
import { AlertDispatchService } from './alert-dispatch.service';
import { PushService } from './push.service';
import { SocketGateway } from './socket-gateway';
import { AlertsController } from './alerts.controller';
import { MeController } from './me.controller';

// The delivery layer. @Global so any module can `@Inject(ALERT_DISPATCHER) @Optional()`
// the AlertDispatcher and `@Inject(REALTIME_PUBLISHER)` the broadcaster without importing this.
@Global()
@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_SECRET || 'dev-access-secret' })],
  controllers: [AlertsController, MeController],
  providers: [
    AlertDispatchService,
    PushService,
    SocketGateway,
    { provide: ALERT_DISPATCHER, useExisting: AlertDispatchService },
    { provide: REALTIME_PUBLISHER, useExisting: SocketGateway },
  ],
  exports: [AlertDispatchService, PushService, SocketGateway, ALERT_DISPATCHER, REALTIME_PUBLISHER],
})
export class NotifyModule {}
