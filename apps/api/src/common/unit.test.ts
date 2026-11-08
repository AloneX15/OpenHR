import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, canonicalJson, decrypt, encrypt, totpCode, verifyTotp } from './crypto';
import { addDays, easterSunday, isoWeekday, localDate, spanishNationalHolidays, zonedToUtc } from './dates';
import { findNationalIds, isValidNationalId } from './spanish-id';

describe('DNI/NIE', () => {
  it('valida la letra de control', () => {
    expect(isValidNationalId('12345678Z')).toBe(true);
    expect(isValidNationalId('12345678A')).toBe(false);
    expect(isValidNationalId('X1234567L')).toBe(true);
    expect(isValidNationalId('Y1234567X')).toBe(true);
    expect(isValidNationalId('12.345.678-z')).toBe(true);
  });

  it('encuentra DNI en el texto de una nómina', () => {
    const text = 'EMPRESA B12345678  Trabajador: GARCIA PEREZ, LUCIA  NIF 12.345.678-Z  Periodo 2026 00000000T';
    expect(findNationalIds(text)).toEqual(expect.arrayContaining(['12345678Z', '00000000T']));
    expect(findNationalIds('Nada por aquí 12345678A')).toEqual([]);
  });
});

describe('cripto', () => {
  it('TOTP coincide con el vector de la RFC 6238', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totpCode(secret, 59_000)).toBe('287082');
    expect(totpCode(secret, 1111111109_000)).toBe('081804');
    expect(verifyTotp(secret, '287082', 59_000 + 30_000)).toBe(true); // tolera un paso de desfase
    expect(verifyTotp(secret, '000000', 59_000)).toBe(false);
  });

  it('base32 ida y vuelta', () => {
    const b = Buffer.from('hola OpenHR');
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
  });

  it('cifra y descifra', () => {
    expect(decrypt(encrypt('secreto'))).toBe('secreto');
  });

  it('JSON canónico ordena claves', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
  });
});

describe('fechas', () => {
  it('Pascua y festivos nacionales', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
    expect(spanishNationalHolidays(2026).find((h) => h.name === 'Viernes Santo')?.date).toBe('2026-04-03');
  });

  it('días de la semana ISO', () => {
    expect(isoWeekday('2026-11-09')).toBe(1);
    expect(isoWeekday('2026-11-08')).toBe(7);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('convierte horas locales de Madrid a UTC, también en el cambio de hora', () => {
    expect(zonedToUtc('2026-07-01', '09:00', 'Europe/Madrid').toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(zonedToUtc('2026-01-15', '09:00', 'Europe/Madrid').toISOString()).toBe('2026-01-15T08:00:00.000Z');
    // 25 de octubre de 2026: a las 03:00 vuelven a ser las 02:00.
    expect(zonedToUtc('2026-10-25', '12:00', 'Europe/Madrid').toISOString()).toBe('2026-10-25T11:00:00.000Z');
    expect(zonedToUtc('2026-03-29', '12:00', 'Europe/Madrid').toISOString()).toBe('2026-03-29T10:00:00.000Z');
    expect(zonedToUtc('2026-07-01', '09:00', 'Atlantic/Canary').toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(localDate(new Date('2026-07-01T22:30:00Z'), 'Europe/Madrid')).toBe('2026-07-02');
  });
});
