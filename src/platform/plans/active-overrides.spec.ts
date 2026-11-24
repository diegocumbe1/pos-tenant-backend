import {
  activeOverrides,
  overrideUntilKey,
  resolveFeatureValue,
} from './plan-features';

describe('activación temporal de features', () => {
  const now = 1_000_000;

  it('mantiene el override mientras no venza', () => {
    const result = activeOverrides(
      { loyaltyProgram: true, [overrideUntilKey('loyaltyProgram')]: now + 1 },
      now,
    );
    expect(result.loyaltyProgram).toBe(true);
  });

  it('descarta el override y su fecha cuando vence', () => {
    const result = activeOverrides(
      { loyaltyProgram: true, [overrideUntilKey('loyaltyProgram')]: now },
      now,
    );
    expect(result).toEqual({});
  });

  it('no toca overrides sin fecha', () => {
    expect(activeOverrides({ loyaltyProgram: true }, now)).toEqual({
      loyaltyProgram: true,
    });
  });

  it('vencida, la feature vuelve al default del plan', () => {
    const expired = {
      loyaltyProgram: true,
      [overrideUntilKey('loyaltyProgram')]: Date.now() - 1000,
    };
    expect(resolveFeatureValue('PRO', 'loyaltyProgram', expired)).toBe(false);
    const live = { ...expired, [overrideUntilKey('loyaltyProgram')]: Date.now() + 60_000 };
    expect(resolveFeatureValue('PRO', 'loyaltyProgram', live)).toBe(true);
  });
});
