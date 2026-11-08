const LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** Normaliza un DNI/NIE: mayúsculas, sin espacios ni guiones. */
export function normalizeNationalId(value: string): string {
  return value.toUpperCase().replace(/[\s.-]/g, '');
}

/** Valida DNI (8 dígitos + letra) y NIE (X/Y/Z + 7 dígitos + letra) con su letra de control. */
export function isValidNationalId(raw: string): boolean {
  const value = normalizeNationalId(raw);
  const m = /^([XYZ]|\d)(\d{7})([A-Z])$/.exec(value);
  if (!m) return false;
  const prefix = { X: '0', Y: '1', Z: '2' }[m[1]] ?? m[1];
  const number = Number(prefix + m[2]);
  return LETTERS[number % 23] === m[3];
}

/** Busca DNI/NIE válidos en un texto libre (p. ej. el texto de una página de nómina). */
export function findNationalIds(text: string): string[] {
  const upper = text.toUpperCase();
  // Dos pasadas: formato compacto (12345678Z) y con separadores (12.345.678-Z).
  const candidates = [
    ...(upper.match(/\b[XYZ]?\d{7,8}[A-Z]\b/g) ?? []),
    ...(upper.match(/\b[XYZ]?\d[\d.-]{5,11}[\s-]?[A-Z]\b/g) ?? []),
  ];
  const found = new Set<string>();
  for (const c of candidates) {
    const n = normalizeNationalId(c);
    if (isValidNationalId(n)) found.add(n);
  }
  return [...found];
}
