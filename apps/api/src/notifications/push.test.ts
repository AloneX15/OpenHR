import { describe, expect, it } from 'vitest';
import { allowedPushEndpoint } from './notifications.service';

describe('servicios de push permitidos', () => {
  const hosts = ['fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];
  it('acepta los servicios de los navegadores', () => {
    expect(allowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc', hosts)).toBe(true);
    expect(allowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x', hosts)).toBe(true);
    expect(allowedPushEndpoint('https://web.push.apple.com/QH', hosts)).toBe(true);
    expect(allowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x', hosts)).toBe(true);
  });
  it('rechaza direcciones internas, http, puertos y dominios parecidos', () => {
    expect(allowedPushEndpoint('http://fcm.googleapis.com/x', hosts)).toBe(false);
    expect(allowedPushEndpoint('https://127.0.0.1/x', hosts)).toBe(false);
    expect(allowedPushEndpoint('https://fcm.googleapis.com:8443/x', hosts)).toBe(false);
    expect(allowedPushEndpoint('https://evilfcm.googleapis.com.attacker.net/x', hosts)).toBe(false);
    expect(allowedPushEndpoint('https://notfcm.googleapis.com/x', hosts)).toBe(false);
    expect(allowedPushEndpoint('https://user@fcm.googleapis.com/x', hosts)).toBe(false);
    expect(allowedPushEndpoint('no es una url', hosts)).toBe(false);
  });
});
