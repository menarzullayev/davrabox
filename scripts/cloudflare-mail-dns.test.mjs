import { describe, expect, it } from 'vitest';
import { DEFAULT_DMARC, DEFAULT_SPF, SENDER, counterpart, plan } from './cloudflare-mail-dns.mjs';

describe('plan', () => {
  it('adds SPF and DMARC (p=none) when Brevo gave only the code and DKIM', () => {
    const p = plan([
      { type: 'txt', name: 'MAIL.davrabox.bugvector.uz.', content: '"brevo-code:abc"' },
      { type: 'CNAME', name: `brevo1._domainkey.${SENDER}`, content: 'b1.x.dkim.brevo.com' },
    ]);
    expect(p).toEqual([
      { type: 'TXT', name: SENDER, content: 'brevo-code:abc' },
      { type: 'CNAME', name: `brevo1._domainkey.${SENDER}`, content: 'b1.x.dkim.brevo.com' },
      { type: 'TXT', name: SENDER, content: DEFAULT_SPF },
      { type: 'TXT', name: `_dmarc.${SENDER}`, content: DEFAULT_DMARC },
    ]);
    expect(DEFAULT_DMARC).toMatch(/p=none/);
  });
  it('keeps the SPF and DMARC Brevo shows instead of the defaults', () => {
    const p = plan([
      { type: 'TXT', name: SENDER, content: 'v=spf1 include:spf.brevo.com mx ~all' },
      { type: 'TXT', name: `_dmarc.${SENDER}`, content: 'v=DMARC1; p=none' },
    ]);
    expect(p).toHaveLength(2);
  });
  it('refuses records outside the sender domain or of other types', () => {
    expect(() => plan([{ type: 'TXT', name: 'bugvector.uz', content: 'x' }])).toThrow(/outside/);
    expect(() => plan([{ type: 'TXT', name: `evil${SENDER}`, content: 'x' }])).toThrow(/outside/);
    expect(() => plan([{ type: 'MX', name: SENDER, content: 'x' }])).toThrow(/unsupported/);
  });
});

describe('counterpart', () => {
  const existing = [
    { id: '1', type: 'TXT', name: SENDER, content: '"v=spf1 -all"' },
    { id: '2', type: 'TXT', name: SENDER, content: 'brevo-code:old' },
    { id: '3', type: 'CNAME', name: `brevo1._domainkey.${SENDER}`, content: 'old.example' },
  ];
  it('matches the same kind of TXT on the same name and replaces CNAMEs by name', () => {
    expect(counterpart({ type: 'TXT', name: SENDER, content: DEFAULT_SPF }, existing)?.id).toBe('1');
    expect(counterpart({ type: 'TXT', name: SENDER, content: 'brevo-code:new' }, existing)?.id).toBe('2');
    expect(counterpart({ type: 'CNAME', name: `brevo1._domainkey.${SENDER}`, content: 'new' }, existing)?.id).toBe('3');
    expect(counterpart({ type: 'TXT', name: `_dmarc.${SENDER}`, content: DEFAULT_DMARC }, existing)).toBeNull();
  });
});
