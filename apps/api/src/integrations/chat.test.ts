import { describe, expect, it } from 'vitest';
import { allowedWebhook, chatPayload } from './chat.service';

describe('webhooks de Slack y Teams', () => {
  it('solo admite las direcciones de cada servicio, por https', () => {
    expect(allowedWebhook('slack', 'https://hooks.slack.com/services/T0/B0/xyz')).not.toBeNull();
    expect(allowedWebhook('slack', 'http://hooks.slack.com/services/T0/B0/xyz')).toBeNull();
    expect(allowedWebhook('slack', 'https://hooks.slack.com.evil.net/x')).toBeNull();
    expect(allowedWebhook('slack', 'https://prod-01.westeurope.logic.azure.com/workflows/x')).toBeNull();
    expect(allowedWebhook('teams', 'https://prod-01.westeurope.logic.azure.com:443/workflows/x/triggers/manual/paths/invoke?sig=1')).not.toBeNull();
    expect(allowedWebhook('teams', 'https://default1234.ab.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/x')).not.toBeNull();
    expect(allowedWebhook('teams', 'https://10.0.0.1/x')).toBeNull();
    expect(allowedWebhook('teams', 'https://logic.azure.com:8080/x')).toBeNull();
  });

  it('da formato al mensaje de cada servicio y escapa el texto de Slack', () => {
    const slack = chatPayload('slack', { title: 'A <b> & c', text: 'Hola', link: '/anuncios' }) as any;
    expect(slack.text).toContain('*A &lt;b&gt; &amp; c*');
    expect(slack.text).toContain('/anuncios|Abrir en OpenHR>');
    const teams = chatPayload('teams', { title: 'T', text: 'X' }) as any;
    expect(teams.attachments[0].content.type).toBe('AdaptiveCard');
    expect(teams.attachments[0].content.actions).toEqual([]);
  });
});
