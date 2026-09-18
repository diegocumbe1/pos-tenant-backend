import { ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../types/tenant-context.interface';

export function assertTenantAccess(user: AuthenticatedUser, tenantId: string, branchId?: string) {
  if (!tenantId) throw new ForbiddenException('Missing X-Tenant-Id header');
  if (!user.isRoot && user.tenantId !== tenantId) throw new ForbiddenException('Tenant mismatch');
  if (branchId && !user.isRoot && !user.accessibleBranches.includes(branchId)) {
    throw new ForbiddenException('Branch not accessible for this user');
  }
}

export function assertPermissions(user: AuthenticatedUser, permissions: Set<string>, required: string[], mode: 'all' | 'any' = 'all') {
  if (user.isRoot || !required.length) return;
  if (mode === 'any' && required.some(code => permissions.has(code))) return;
  if (mode === 'all' && required.every(code => permissions.has(code))) return;
  throw new ForbiddenException('Missing required permissions');
}
