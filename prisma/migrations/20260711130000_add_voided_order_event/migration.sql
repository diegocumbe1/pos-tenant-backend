-- Add audit event for orders voided without financial impact.
ALTER TYPE "OrderEventType" ADD VALUE IF NOT EXISTS 'VOIDED';
