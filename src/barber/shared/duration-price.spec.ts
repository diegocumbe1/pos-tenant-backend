import {
  appointmentPriceCOP,
  priceForMinutes,
  storedPriceForDuration,
} from './duration-price';

const cancha = { priceCOP: 30000, durationMin: 60, durationOptions: [] };

describe('precio por duración', () => {
  it('2 horas de una cancha de $30.000/h son $60.000 (el caso reportado)', () => {
    expect(priceForMinutes(cancha, 120)).toBe(60000);
    expect(priceForMinutes(cancha, 90)).toBe(45000);
  });

  it('la duración base vale el precio del servicio y no se guarda aparte', () => {
    expect(priceForMinutes(cancha, 60)).toBe(30000);
    expect(storedPriceForDuration(cancha, 60)).toBeNull();
    expect(storedPriceForDuration(cancha, 120)).toBe(60000);
  });

  it('un bloque con precio propio manda sobre el proporcional', () => {
    const conPaquete = {
      ...cancha,
      durationOptions: [{ minutes: 120, price: 55000 }],
    };
    expect(priceForMinutes(conPaquete, 120)).toBe(55000);
    expect(priceForMinutes(conPaquete, 180)).toBe(90000);
  });

  it('cita sin precio guardado: usa su duración real', () => {
    expect(
      appointmentPriceCOP({
        priceCOP: null,
        scheduledAt: new Date('2026-11-09T21:00:00Z'),
        scheduledEnd: new Date('2026-11-09T23:00:00Z'),
        service: cancha,
      }),
    ).toBe(60000);
  });

  it('un servicio de 30 min a $20.000 cobra 60 min a $40.000', () => {
    expect(priceForMinutes({ priceCOP: 20000, durationMin: 30 }, 60)).toBe(
      40000,
    );
  });
});
