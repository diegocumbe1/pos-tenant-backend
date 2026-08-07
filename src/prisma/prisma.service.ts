import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { performance } from 'perf_hooks';
import { RequestMetricsStore } from '../monitoring/request-metrics.store';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    super({
      log: [
        { emit: 'stdout', level: 'error' },
        { emit: 'stdout', level: 'warn' },
      ],
    });

    const instrumentedClient = this.$extends({
      query: {
        $allModels: {
          async $allOperations({ query, args }) {
            const startedAt = performance.now();
            try {
              return await query(args);
            } finally {
              RequestMetricsStore.recordPrismaQuery(performance.now() - startedAt);
            }
          },
        },
      },
    }) as this & {
      onModuleInit?: () => Promise<void>;
      onModuleDestroy?: () => Promise<void>;
    };

    instrumentedClient.onModuleInit = async () => {
      await instrumentedClient.$connect();
    };
    instrumentedClient.onModuleDestroy = async () => {
      await instrumentedClient.$disconnect();
    };

    return instrumentedClient as this;
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
