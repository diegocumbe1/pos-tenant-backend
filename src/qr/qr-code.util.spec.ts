import {
  assertValidQrTarget,
  buildQrCode,
  buildQrScanUrl,
  QR_CODE_REGEX,
  qrPrefixFrom,
  resolveQrTarget,
} from './qr-code.util';

describe('qr-code.util', () => {
  describe('qrPrefixFrom', () => {
    it('usa las iniciales cuando el nombre tiene varias palabras', () => {
      expect(qrPrefixFrom('Bella Chic')).toBe('bc');
    });

    it('recorta a tres letras si es una sola palabra', () => {
      expect(qrPrefixFrom('Monserrate')).toBe('mon');
    });

    it('sobrevive a tildes, emojis y nombres vacíos', () => {
      expect(qrPrefixFrom('Café Ñandú')).toBe('cn');
      expect(qrPrefixFrom('   ')).toBe('ly');
      expect(qrPrefixFrom('💈')).toBe('ly');
    });
  });

  describe('buildQrCode', () => {
    it('no repite códigos y evita los caracteres ambiguos', () => {
      const codes = new Set<string>();
      for (let i = 0; i < 500; i += 1) {
        const code = buildQrCode('Bella Chic');
        expect(code).toMatch(/^bc-[A-Za-z2-9]{7}$/);
        // 0/O/o y 1/l/I se leen mal cuando alguien teclea el código impreso.
        expect(code.slice(3)).not.toMatch(/[0O1lI]/);
        codes.add(code);
      }
      expect(codes.size).toBe(500);
    });

    it('produce códigos que el endpoint público acepta', () => {
      expect(QR_CODE_REGEX.test(buildQrCode('Bella Chic'))).toBe(true);
    });

    it('no es enumerable: nada de consecutivos', () => {
      const a = buildQrCode('Bella Chic');
      const b = buildQrCode('Bella Chic');
      expect(a).not.toBe(b);
    });
  });

  describe('resolveQrTarget', () => {
    it('resuelve rutas internas contra la base del entorno', () => {
      expect(resolveQrTarget('/sites/bella-chic', 'https://uselynko.com')).toBe(
        'https://uselynko.com/sites/bella-chic',
      );
      // La misma fila apunta a localhost en desarrollo.
      expect(resolveQrTarget('/sites/bella-chic', 'http://localhost:3000/')).toBe(
        'http://localhost:3000/sites/bella-chic',
      );
    });

    it('deja pasar las absolutas tal cual', () => {
      expect(resolveQrTarget('https://instagram.com/bc', 'https://uselynko.com')).toBe(
        'https://instagram.com/bc',
      );
    });
  });

  describe('buildQrScanUrl', () => {
    it('codifica /q/<code> y no el destino', () => {
      expect(buildQrScanUrl('bc-A7kPq92', 'https://uselynko.com/')).toBe(
        'https://uselynko.com/q/bc-A7kPq92',
      );
    });
  });

  describe('assertValidQrTarget', () => {
    it('acepta rutas internas y URLs http(s)', () => {
      expect(assertValidQrTarget(' /c/bella-chic ')).toBe('/c/bella-chic');
      expect(assertValidQrTarget('https://uselynko.com/sites/x')).toBe(
        'https://uselynko.com/sites/x',
      );
    });

    it('rechaza javascript: y otros esquemas', () => {
      // El QR se escanea a ciegas: un esquema raro guardado por error es un
      // vector, no una molestia.
      expect(() => assertValidQrTarget('javascript:alert(1)')).toThrow();
      expect(() => assertValidQrTarget('data:text/html,<script>')).toThrow();
    });

    it('rechaza // porque parece interna y sale del dominio', () => {
      expect(() => assertValidQrTarget('//evil.com')).toThrow();
    });

    it('rechaza el destino vacío', () => {
      expect(() => assertValidQrTarget('   ')).toThrow();
    });
  });
});
