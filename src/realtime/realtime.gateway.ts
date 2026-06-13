import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import * as jwt from 'jsonwebtoken';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseJwtPayload } from '../auth/types/jwt-payload.interface';
import {
  KITCHEN_TICKET_UPDATED,
  KitchenTicketUpdatedEvent,
  ORDER_CLOSED,
  OrderClosedEvent,
  TABLE_UPDATED,
  TableUpdatedEvent,
} from './realtime.events';

interface AuthedSocket extends Socket {
  data: {
    tenantId: string;
    branchId: string;
    userId: string;
    roleCode: string;
    isRoot: boolean;
  };
}

@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      if (!token) throw new Error('Missing token');

      const secret = this.config.getOrThrow<string>('SUPABASE_JWT_SECRET');
      const payload = jwt.verify(token, secret, {
        audience: 'authenticated',
      }) as SupabaseJwtPayload;

      if (!payload.sub) throw new Error('Invalid token: missing sub');

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        include: {
          role: true,
          userBranches: { select: { branchId: true } },
        },
      });
      if (!user) throw new Error('User not provisioned');
      if (!user.isActive) throw new Error('User inactive');
      // Nota: NO exigimos passwordSetAt aquí. El realtime es solo lectura (recibe
      // eventos) y los endpoints REST del POS (orders/tables) tampoco lo exigen
      // (solo JwtAuthGuard + TenantGuard). Pedirlo aquí dejaba a dueños creados por
      // signup directo con "REALTIME: Pendiente" → no recibían cambios en vivo.

      const isRoot = user.role.code === 'ROOT';
      const branchId =
        (client.handshake.auth?.branchId as string) ||
        (client.handshake.query?.branchId as string);
      if (!branchId) throw new Error('Missing branchId');

      const tenantId =
        (client.handshake.auth?.tenantId as string) ||
        (client.handshake.query?.tenantId as string) ||
        user.tenantId;
      if (!tenantId) throw new Error('Missing tenantId');

      if (!isRoot && user.tenantId !== tenantId) {
        throw new Error('Tenant mismatch');
      }
      const accessibleBranches = user.userBranches.map((ub) => ub.branchId);
      if (!isRoot && !accessibleBranches.includes(branchId)) {
        throw new Error('Branch not accessible');
      }

      (client as AuthedSocket).data = {
        tenantId,
        branchId,
        userId: user.id,
        roleCode: user.role.code,
        isRoot,
      };

      void client.join(this.roomFor(tenantId, branchId));
      this.logger.log(
        `client connected: ${client.id} tenant=${tenantId} branch=${branchId} role=${user.role.code}`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unauthorized';
      this.logger.warn(`rejected ws ${client.id}: ${reason}`);
      client.emit('unauthorized', { reason });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`client disconnected: ${client.id}`);
  }

  @OnEvent(KITCHEN_TICKET_UPDATED)
  onKitchenTicketUpdated(event: KitchenTicketUpdatedEvent) {
    this.server
      .to(this.roomFor(event.tenantId, event.branchId))
      .emit('kitchen:ticket:updated', event.ticket);
  }

  @OnEvent(TABLE_UPDATED)
  onTableUpdated(event: TableUpdatedEvent) {
    this.server
      .to(this.roomFor(event.tenantId, event.branchId))
      .emit('table:updated', {
        tableId: event.tableId,
        reason: event.reason,
      });
  }

  @OnEvent(ORDER_CLOSED)
  onOrderClosed(event: OrderClosedEvent) {
    this.server
      .to(this.roomFor(event.tenantId, event.branchId))
      .emit('order:closed', {
        orderId: event.orderId,
        tableId: event.tableId,
        totalCOP: event.totalCOP,
      });
  }

  private roomFor(tenantId: string, branchId: string) {
    return `tenant:${tenantId}:branch:${branchId}`;
  }

  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth?.token as string | undefined;
    if (auth) return auth.replace(/^Bearer\s+/i, '');
    const header = client.handshake.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);
    const qp = client.handshake.query?.token;
    if (typeof qp === 'string') return qp;
    return null;
  }
}
