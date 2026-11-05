import { matchBusinessName, phoneticKey } from './spoken-name';

describe('matchBusinessName', () => {
  const list = [
    { name: 'Bella Chic' },
    { name: 'DC Tech' },
    { name: 'Malexca' },
    { name: 'Lynko' },
  ];
  const resolved = (spoken: string) => {
    const match = matchBusinessName(list, spoken);
    return match.status === 'resolved' ? match.business.name : match.status;
  };

  it.each([
    ['bellachi', 'Bella Chic'],
    ['bella chi', 'Bella Chic'],
    ['vella chic', 'Bella Chic'],
    ['bella shic', 'Bella Chic'],
    ['linco', 'Lynko'],
    ['lingo', 'Lynko'],
    ['lincoln', 'Lynko'],
    ['linko', 'Lynko'],
    ['malesca', 'Malexca'],
    ['malexa', 'Malexca'],
  ])('"%s" es %s', (spoken, expected) => {
    expect(resolved(spoken)).toBe(expected);
  });

  it.each(['ferretería ajena', 'panadería', 'xyz'])(
    'no adivina con "%s"',
    (spoken) => {
      expect(resolved(spoken)).toBe('unknown');
    },
  );

  it('pregunta si dos nombres suenan igual', () => {
    const twins = [{ name: 'Linco' }, { name: 'Lynko' }];
    expect(matchBusinessName(twins, 'linko').status).toBe('ambiguous');
  });

  it('un nombre exacto gana a uno parecido', () => {
    const twins = [{ name: 'Linco' }, { name: 'Lynko' }];
    expect(matchBusinessName(twins, 'lynko')).toEqual({
      status: 'resolved',
      business: { name: 'Lynko' },
    });
  });

  it('da la misma clave a lo que suena igual', () => {
    expect(phoneticKey('Lynko')).toBe(phoneticKey('linco'));
    expect(phoneticKey('Bella Chic')).toBe(phoneticKey('vella chik'));
  });
});
