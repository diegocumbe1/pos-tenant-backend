export interface JwtPayload {
  sub: string;       // userId
  email: string;
  name: string;
  tenantId: string;
  role: string;      // 'OWNER' | 'MANAGER' | 'WAITER' | 'KITCHEN' | 'CASHIER'
  iat?: number;
  exp?: number;
}
