/** Cálculo de resultados de encuestas (puro, sin base de datos). */

export interface Question {
  id: string;
  kind: 'scale' | 'enps' | 'choice' | 'text';
  text: string;
  options: string[];
  required: boolean;
}

export type Answers = Record<string, number | string>;

/** Valida y normaliza las respuestas de una persona. Lanza un mensaje legible si algo no encaja. */
export function validateAnswers(questions: Question[], raw: Record<string, unknown>): Answers {
  const out: Answers = {};
  for (const q of questions) {
    const v = raw[q.id];
    if (v === undefined || v === null || v === '') {
      if (q.required) throw new Error(`Falta responder: «${q.text}»`);
      continue;
    }
    if (q.kind === 'scale' || q.kind === 'enps') {
      const n = Number(v);
      const [min, max] = q.kind === 'scale' ? [1, 5] : [0, 10];
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Respuesta no válida en «${q.text}»`);
      out[q.id] = n;
    } else if (q.kind === 'choice') {
      if (typeof v !== 'string' || !q.options.includes(v)) throw new Error(`Opción no válida en «${q.text}»`);
      out[q.id] = v;
    } else {
      const t = String(v).trim().slice(0, 2000);
      if (t) out[q.id] = t;
      else if (q.required) throw new Error(`Falta responder: «${q.text}»`);
    }
  }
  const unknown = Object.keys(raw).filter((k) => !questions.some((q) => q.id === k));
  if (unknown.length) throw new Error('Hay respuestas a preguntas que no son de esta encuesta');
  return out;
}

/** Desordena (Fisher-Yates) para que el orden de los comentarios no delate a nadie. */
export function shuffle<T>(list: T[], rnd = Math.random): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function summarize(questions: Question[], responses: Answers[]) {
  return questions.map((q) => {
    const values = responses.map((r) => r[q.id]).filter((v) => v !== undefined);
    const base = { id: q.id, kind: q.kind, text: q.text, answered: values.length };
    if (q.kind === 'scale' || q.kind === 'enps') {
      const nums = values.map(Number);
      const [min, max] = q.kind === 'scale' ? [1, 5] : [0, 10];
      const distribution = Array.from({ length: max - min + 1 }, (_, i) => ({ value: min + i, count: nums.filter((n) => n === min + i).length }));
      const average = nums.length ? Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 100) / 100 : null;
      if (q.kind === 'scale') return { ...base, average, distribution };
      const promoters = nums.filter((n) => n >= 9).length;
      const detractors = nums.filter((n) => n <= 6).length;
      const enps = nums.length ? Math.round(((promoters - detractors) / nums.length) * 100) : null;
      return { ...base, average, distribution, enps, promoters, passives: nums.length - promoters - detractors, detractors };
    }
    if (q.kind === 'choice') return { ...base, options: q.options.map((o) => ({ option: o, count: values.filter((v) => v === o).length })) };
    return { ...base, comments: shuffle(values.map(String)) };
  });
}
