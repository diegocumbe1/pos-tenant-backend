#!/usr/bin/env node
/**
 * Genera tokens JWT de prueba para desarrollo local.
 * Uso: node scripts/gen-token.js [role]
 * Roles: OWNER (default) | MANAGER | WAITER | KITCHEN | CASHIER
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-super-secret-change-in-production';

const users = {
  OWNER:   { sub: 'user-001', email: 'carlos@oriwok.com',  name: 'Carlos', tenantId: 'tenant-001', role: 'OWNER' },
  MANAGER: { sub: 'user-002', email: 'ana@oriwok.com',     name: 'Ana',    tenantId: 'tenant-001', role: 'MANAGER' },
  WAITER:  { sub: 'user-003', email: 'pedro@oriwok.com',   name: 'Pedro',  tenantId: 'tenant-001', role: 'WAITER' },
  KITCHEN: { sub: 'user-004', email: 'luisa@oriwok.com',   name: 'Luisa',  tenantId: 'tenant-001', role: 'KITCHEN' },
  CASHIER: { sub: 'user-005', email: 'sofia@oriwok.com',   name: 'Sofía',  tenantId: 'tenant-001', role: 'CASHIER' },
};

const role = (process.argv[2] || 'OWNER').toUpperCase();
const payload = users[role];

if (!payload) {
  console.error(`❌ Role "${role}" not found. Use: OWNER | MANAGER | WAITER | KITCHEN | CASHIER`);
  process.exit(1);
}

const token = jwt.sign(payload, SECRET, { expiresIn: '30d' });

console.log(`\n🔑 Token for ${payload.name} (${role})\n`);
console.log(`Bearer ${token}\n`);
console.log(`# Headers para curl:`);
console.log(`export TOKEN="Bearer ${token}"`);
console.log(`export BASE="http://localhost:3001/api/v1"`);
console.log(`# -H "Authorization: $TOKEN" -H "X-Tenant-Id: tenant-001" -H "X-Branch-Id: branch-001"\n`);
