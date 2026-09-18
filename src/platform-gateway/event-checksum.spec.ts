import { createHash } from 'node:crypto';
import {
  WompiEvent,
  checksumMatches,
  eventChecksum,
  readTransaction,
} from './event-checksum';

const SECRET = 'test_events_abc123';

function makeEvent(overrides: Partial<WompiEvent> = {}): WompiEvent {
  const base: WompiEvent = {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: '1234-1610641025-49201',
        reference: 'LYNKO-barberia-202609-a1b2',
        status: 'APPROVED',
        amount_in_cents: 4490000,
        payment_method_type: 'CARD',
        finalized_at: '2026-09-17T15:04:05.000Z',
        customer_email: 'dueno@negocio.co',
      },
    },
    environment: 'test',
    signature: {
      properties: [
        'transaction.id',
        'transaction.status',
        'transaction.amount_in_cents',
      ],
      checksum: '',
    },
    timestamp: 1530291411,
  };
  return { ...base, ...overrides };
}

function sign(event: WompiEvent): WompiEvent {
  const checksum = eventChecksum(event, SECRET);
  return {
    ...event,
    signature: { ...event.signature, checksum: checksum ?? '' },
  };
}

describe('eventChecksum', () => {
  it('concatena las propiedades en orden + timestamp + secreto', () => {
    const expected = createHash('sha256')
      .update('1234-1610641025-49201APPROVED4490000' + '1530291411' + SECRET)
      .digest('hex');

    expect(eventChecksum(makeEvent(), SECRET)).toBe(expected);
  });

  it('respeta el orden que manda el evento, no uno fijo', () => {
    const reordered = makeEvent({
      signature: {
        properties: [
          'transaction.status',
          'transaction.id',
          'transaction.amount_in_cents',
        ],
        checksum: '',
      },
    });
    expect(eventChecksum(reordered, SECRET)).not.toBe(
      eventChecksum(makeEvent(), SECRET),
    );
  });

  it('no firma si falta una propiedad: se rechazaría por la razón equivocada', () => {
    const missing = makeEvent({ data: { transaction: { id: 'x' } } });
    expect(eventChecksum(missing, SECRET)).toBeNull();
  });

  it('no firma sin timestamp', () => {
    expect(
      eventChecksum(makeEvent({ timestamp: undefined }), SECRET),
    ).toBeNull();
  });
});

describe('checksumMatches', () => {
  it('acepta un evento bien firmado', () => {
    expect(checksumMatches(sign(makeEvent()), SECRET)).toBe(true);
  });

  it('rechaza si cambian el monto después de firmar', () => {
    const signed = sign(makeEvent());
    const tampered: WompiEvent = {
      ...signed,
      data: {
        transaction: {
          ...(signed.data!.transaction as Record<string, unknown>),
          amount_in_cents: 100,
        },
      },
    };
    expect(checksumMatches(tampered, SECRET)).toBe(false);
  });

  it('rechaza con otro secreto', () => {
    expect(checksumMatches(sign(makeEvent()), 'test_events_otro')).toBe(false);
  });

  it('rechaza un evento sin checksum', () => {
    expect(checksumMatches(makeEvent(), SECRET)).toBe(false);
  });
});

describe('readTransaction', () => {
  it('aplana la transacción del evento', () => {
    const tx = readTransaction(makeEvent().data);
    expect(tx.id).toBe('1234-1610641025-49201');
    expect(tx.status).toBe('APPROVED');
    expect(tx.amountInCents).toBe(4490000);
    expect(tx.paymentMethodType).toBe('CARD');
    expect(tx.reference).toBe('LYNKO-barberia-202609-a1b2');
  });

  it('sirve igual con la respuesta de GET /transactions/:id', () => {
    const tx = readTransaction({ id: 'abc', status: 'DECLINED' });
    expect(tx.id).toBe('abc');
    expect(tx.status).toBe('DECLINED');
    expect(tx.amountInCents).toBeNull();
  });
});
