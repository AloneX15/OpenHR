import { describe, expect, it } from 'vitest';
import { Question, shuffle, summarize, validateAnswers } from './results';

const qs: Question[] = [
  { id: 'a', kind: 'scale', text: '¿Estás a gusto?', options: [], required: true },
  { id: 'b', kind: 'enps', text: '¿Recomendarías la empresa?', options: [], required: true },
  { id: 'c', kind: 'choice', text: 'Modalidad', options: ['Oficina', 'Remoto'], required: false },
  { id: 'd', kind: 'text', text: 'Comentarios', options: [], required: false },
];

describe('encuestas', () => {
  it('valida las respuestas', () => {
    expect(validateAnswers(qs, { a: 4, b: '9', d: '  bien  ' })).toEqual({ a: 4, b: 9, d: 'bien' });
    expect(() => validateAnswers(qs, { b: 9 })).toThrow('Falta responder');
    expect(() => validateAnswers(qs, { a: 6, b: 9 })).toThrow('no válida');
    expect(() => validateAnswers(qs, { a: 3, b: 11 })).toThrow('no válida');
    expect(() => validateAnswers(qs, { a: 3, b: 5, c: 'Playa' })).toThrow('Opción');
    expect(() => validateAnswers(qs, { a: 3, b: 5, z: 1 })).toThrow('no son de esta encuesta');
  });

  it('calcula medias, distribución y eNPS', () => {
    const [scale, enps, choice, text] = summarize(qs, [
      { a: 5, b: 10, c: 'Remoto', d: 'x' },
      { a: 4, b: 9 },
      { a: 3, b: 7 },
      { a: 2, b: 3, c: 'Remoto' },
    ]) as any[];
    expect(scale.average).toBe(3.5);
    expect(scale.distribution.find((d: any) => d.value === 5).count).toBe(1);
    expect(enps).toMatchObject({ enps: 25, promoters: 2, passives: 1, detractors: 1 });
    expect(choice.options).toEqual([{ option: 'Oficina', count: 0 }, { option: 'Remoto', count: 2 }]);
    expect(text.comments).toEqual(['x']);
  });

  it('desordena sin perder elementos', () => {
    expect(shuffle([1, 2, 3, 4], () => 0).sort()).toEqual([1, 2, 3, 4]);
  });
});
