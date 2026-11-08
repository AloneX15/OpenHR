'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { Card, ErrorBox, Notice, PageHeader, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';

/** Responder una encuesta. */
export default function AnswerSurveyPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error } = useLoad(() => api.get<any>(`/surveys/${id}`), [id]);
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  const [done, setDone] = useState(false);
  const { busy, error: sendError, run } = useAction();
  const set = (q: string, v: string | number) => setAnswers({ ...answers, [q]: v });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api.post(`/surveys/${id}/responses`, { answers });
      setDone(true);
    });
  };

  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  return (
    <>
      <PageHeader title={data.title} subtitle={data.anonymous ? 'Encuesta anónima: nadie podrá ver qué has respondido tú.' : 'Encuesta con nombre: RR. HH. verá tus respuestas.'} />
      {done || data.answered ? (
        <Card>
          <Notice tone="success">Gracias por responder.</Notice>
          <Link href="/encuestas" className="btn">
            Volver a encuestas
          </Link>
        </Card>
      ) : (
        <form onSubmit={submit} className="stack">
          {data.description && <Notice>{data.description}</Notice>}
          {data.questions.map((q: any, i: number) => (
            <Card key={q.id}>
              <fieldset className="survey-q">
                <legend>
                  {i + 1}. {q.text} {!q.required && <span className="small muted">(opcional)</span>}
                </legend>
                {(q.kind === 'scale' || q.kind === 'enps') && (
                  <>
                    <div className="scale" role="radiogroup">
                      {Array.from({ length: q.kind === 'scale' ? 5 : 11 }, (_, k) => (q.kind === 'scale' ? k + 1 : k)).map((n) => (
                        <label key={n} className={answers[q.id] === n ? 'scale-opt on' : 'scale-opt'}>
                          <input type="radio" name={q.id} value={n} required={q.required} checked={answers[q.id] === n} onChange={() => set(q.id, n)} />
                          {n}
                        </label>
                      ))}
                    </div>
                    <div className="row small muted" style={{ justifyContent: 'space-between' }}>
                      <span>{q.kind === 'scale' ? 'Nada de acuerdo' : 'Nada probable'}</span>
                      <span>{q.kind === 'scale' ? 'Totalmente de acuerdo' : 'Muy probable'}</span>
                    </div>
                  </>
                )}
                {q.kind === 'choice' &&
                  q.options.map((o: string) => (
                    <label key={o} className="check">
                      <input type="radio" name={q.id} value={o} required={q.required} checked={answers[q.id] === o} onChange={() => set(q.id, o)} /> {o}
                    </label>
                  ))}
                {q.kind === 'text' && <textarea rows={3} maxLength={2000} required={q.required} value={(answers[q.id] as string) ?? ''} onChange={(e) => set(q.id, e.target.value)} />}
              </fieldset>
            </Card>
          ))}
          <ErrorBox error={sendError} />
          <div>
            <button className="btn btn-primary" disabled={busy}>
              Enviar respuestas
            </button>
          </div>
        </form>
      )}
    </>
  );
}
