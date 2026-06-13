import { AsyncLocalStorage } from 'async_hooks';

export type RequestMetrics = {
  requestId: string;
  startedAt: number;
  prismaQueryCount: number;
  prismaDbTimeMs: number;
  slowestPrismaQueryMs: number;
  timings: Record<string, number>;
};

const storage = new AsyncLocalStorage<RequestMetrics>();

export class RequestMetricsStore {
  static run<T>(metrics: RequestMetrics, callback: () => T): T {
    return storage.run(metrics, callback);
  }

  static current(): RequestMetrics | undefined {
    return storage.getStore();
  }

  static recordPrismaQuery(durationMs: number): void {
    const metrics = storage.getStore();
    if (!metrics) return;

    metrics.prismaQueryCount += 1;
    metrics.prismaDbTimeMs += durationMs;
    metrics.slowestPrismaQueryMs = Math.max(
      metrics.slowestPrismaQueryMs,
      durationMs,
    );
  }

  static recordTiming(name: string, durationMs: number): void {
    const metrics = storage.getStore();
    if (!metrics) return;
    metrics.timings[name] = durationMs;
  }
}
