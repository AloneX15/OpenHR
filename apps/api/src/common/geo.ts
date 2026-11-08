/** Distancia en metros entre dos coordenadas (fórmula del haversine). */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * ¿La posición está dentro de la zona? Se concede el margen de precisión del dispositivo
 * (hasta 100 m) para no rechazar a quien está en la puerta con un GPS impreciso.
 */
export function insideZone(center: { lat: number; lng: number; radius: number }, pos: { lat: number; lng: number; accuracy?: number | null }): boolean {
  const margin = Math.min(Math.max(pos.accuracy ?? 0, 0), 100);
  return distanceMeters(center.lat, center.lng, pos.lat, pos.lng) <= center.radius + margin;
}
