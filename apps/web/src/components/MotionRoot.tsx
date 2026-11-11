'use client';

import { useEffect } from 'react';
import { installPressFeedback } from '@/lib/motion';

/** Activa la respuesta al pulsar de los botones en toda la aplicación. */
export function MotionRoot() {
  useEffect(() => installPressFeedback(), []);
  return null;
}
