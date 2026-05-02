import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

interface CacheEntry {
  permissions: Set<string>;
  expiresAt: number;
}

const TTL_MS = 60_000;

@Injectable()
export class PermissionsCacheService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  async getForRole(roleId: string): Promise<Set<string>> {
    const now = Date.now();
    const hit = this.cache.get(roleId);
    if (hit && hit.expiresAt > now) {
      return hit.permissions;
    }

    const rows = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permission: { select: { code: true } } },
    });
    const permissions = new Set(rows.map((r) => r.permission.code));
    this.cache.set(roleId, { permissions, expiresAt: now + TTL_MS });
    return permissions;
  }

  invalidate(roleId: string): void {
    this.cache.delete(roleId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}
