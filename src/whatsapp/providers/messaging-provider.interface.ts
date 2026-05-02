export const MESSAGING_PROVIDER = Symbol('MESSAGING_PROVIDER');

export interface IMessagingProvider {
  sendText(input: {
    tenantId: string;
    branchId: string;
    to: string;
    body: string;
  }): Promise<{ id: string }>;

  isReady(tenantId: string, branchId: string): Promise<boolean>;
}
