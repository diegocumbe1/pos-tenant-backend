import { SendGuard } from './send-guard';

describe('SendGuard', () => {
  afterEach(() => jest.useRealTimers());

  it('descarta el mismo mensaje dentro de la ventana y lo permite después', () => {
    jest.useFakeTimers();
    const guard = new SendGuard(60_000);
    const msg = ['tenant', 'branch', 'APPOINTMENT_CUSTOMER', '3001234567', 'Hola'];

    expect(guard.isDuplicate(msg)).toBe(false);
    guard.rememberSent(msg);
    expect(guard.isDuplicate(msg)).toBe(true);

    jest.advanceTimersByTime(60_000);
    expect(guard.isDuplicate(msg)).toBe(false);
  });

  it('no confunde mensajes distintos', () => {
    const guard = new SendGuard(60_000);
    guard.rememberSent(['t', 'b', 'K', '3001234567', 'Hola']);
    expect(guard.isDuplicate(['t', 'b', 'K', '3001234567', 'Hola!'])).toBe(false);
    expect(guard.isDuplicate(['t', 'b', 'K', '3007654321', 'Hola'])).toBe(false);
  });

  it('respeta el tope por clave y libera cupo al vencer la ventana', () => {
    jest.useFakeTimers();
    const guard = new SendGuard(60_000);

    expect(guard.tryConsume('k', 2, 1_000)).toBe(true);
    expect(guard.tryConsume('k', 2, 1_000)).toBe(true);
    expect(guard.tryConsume('k', 2, 1_000)).toBe(false);
    expect(guard.tryConsume('otra', 2, 1_000)).toBe(true);

    jest.advanceTimersByTime(1_000);
    expect(guard.tryConsume('k', 2, 1_000)).toBe(true);
  });
});
