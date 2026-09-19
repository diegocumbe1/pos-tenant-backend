import { AlexaSkill, AssistantOutcome } from '@prisma/client';
import { IntentRequest, RequestEnvelope } from 'ask-sdk-model';
import { AssistantScopeService } from '../../assistant/assistant-scope.service';
import { AssistantService } from '../../assistant/assistant.service';
import { AssistantTelemetryService } from '../../assistant/telemetry/telemetry.service';
import { AlexaAuthService } from './alexa-auth.service';
import {
  AlexaSkillRepository,
  TelemetryAlexaSkill,
} from './alexa-skill.repository';
import { AlexaService } from './alexa.service';

const skill = {
  tenantId: 'tenant-a',
  tenant: { vertical: { code: 'retail' } },
  actingUser: { role: { code: 'OWNER' } },
} as TelemetryAlexaSkill;
const envelope = {} as RequestEnvelope;
const intent = (name: string): IntentRequest => ({
  type: 'IntentRequest',
  requestId: 'test',
  timestamp: new Date().toISOString(),
  dialogState: 'COMPLETED',
  intent: {
    name,
    confirmationStatus: 'NONE',
    slots: {
      producto: {
        name: 'producto',
        value: 'private product',
        confirmationStatus: 'NONE',
      },
    },
  },
});
function build() {
  const record = jest.fn();
  const assistant = {
    sales: jest.fn().mockResolvedValue({
      business: { id: 'tenant-b', name: 'Private business' },
      salesCount: 0,
      period: 'day',
    }),
  };
  const service = new AlexaService(
    {} as AlexaSkillRepository,
    {
      actor: jest.fn().mockResolvedValue({ roleCode: 'OWNER' }),
    } as unknown as AlexaAuthService,
    assistant as unknown as AssistantService,
    {
      resolveBusiness: jest.fn().mockResolvedValue({
        status: 'resolved',
        business: {
          id: 'tenant-b',
          name: 'Private business',
          vertical: { code: 'retail' },
        },
      }),
    } as unknown as AssistantScopeService,
    { record } as unknown as AssistantTelemetryService,
  );
  return { service, record, assistant };
}
it('emits fallback exactly once for a tenant-bound skill without retaining slots', async () => {
  const { service, record } = build();
  await service['observedIntent'](
    envelope,
    skill,
    intent('AMAZON.FallbackIntent'),
  );
  expect(record).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: 'tenant-a' }),
    [
      expect.objectContaining({
        intentId: 'fallback',
        outcome: AssistantOutcome.FALLBACK,
      }),
    ],
    'ALEXA',
  );
  expect(JSON.stringify(record.mock.calls)).not.toContain('private product');
});
it('attributes empty answers to the resolved business and keeps concurrent requests isolated', async () => {
  const { service, record } = build();
  await Promise.all([
    service['observedIntent'](envelope, skill, intent('sales_summary')),
    service['observedIntent'](envelope, skill, intent('AMAZON.FallbackIntent')),
  ]);
  expect(record).toHaveBeenCalledTimes(2);
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: 'tenant-b' }),
    [
      expect.objectContaining({
        intentId: 'sales_summary',
        outcome: 'NO_DATA',
      }),
    ],
    'ALEXA',
  );
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({ tenantId: 'tenant-a' }),
    [expect.objectContaining({ outcome: 'FALLBACK' })],
    'ALEXA',
  );
  expect(JSON.stringify(record.mock.calls)).not.toContain('Private business');
});
it('emits ERROR once when the business query fails', async () => {
  const { service, record, assistant } = build();
  assistant.sales.mockRejectedValue(new Error('offline'));
  await expect(
    service['observedIntent'](
      envelope,
      skill as AlexaSkill,
      intent('sales_summary'),
    ),
  ).rejects.toThrow('offline');
  expect(record).toHaveBeenCalledTimes(1);
  expect(record).toHaveBeenCalledWith(
    expect.anything(),
    [expect.objectContaining({ outcome: 'ERROR' })],
    'ALEXA',
  );
});
