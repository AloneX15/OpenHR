import { describe, expect, it } from 'vitest';
import { distanceMeters, insideZone } from './geo';

describe('geolocalización', () => {
  it('calcula distancias', () => {
    // Puerta del Sol a Plaza Mayor (Madrid): unos 400 m.
    const d = distanceMeters(40.4169, -3.7035, 40.4155, -3.7074);
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(450);
  });

  it('concede el margen de precisión con un máximo de 100 m', () => {
    const center = { lat: 40.4169, lng: -3.7035, radius: 100 };
    expect(insideZone(center, { lat: 40.4169, lng: -3.7035 })).toBe(true);
    expect(insideZone(center, { lat: 40.4155, lng: -3.7074, accuracy: 50 })).toBe(false);
    expect(insideZone(center, { lat: 40.4155, lng: -3.7074, accuracy: 5000 })).toBe(false);
  });
});
