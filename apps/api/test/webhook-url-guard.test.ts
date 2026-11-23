import { describe, expect, it } from 'vitest';
import { UrlRejectedError, assertPublicHttpsUrl, isPublicIp, resolvePublicHttpsUrl, type Resolver } from '../src/ext-api/url-guard.js';

const fixed = (map: Record<string, string[]>): Resolver & { calls: string[] } => {
  const calls: string[] = [];
  const fn = (async (host: string) => {
    calls.push(host);
    const r = map[host];
    if (!r) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return r;
  }) as Resolver & { calls: string[] };
  fn.calls = calls;
  return fn;
};

describe('isPublicIp: IPv4', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '100.100.100.200', '127.0.0.1', '127.255.255.254',
    '169.254.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.0.192', '192.0.2.1', '192.88.99.1', '192.168.0.1',
    '192.168.255.255', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '168.63.129.16', // Azure wire server
  ];
  const open = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '169.253.255.255', '169.255.0.0', '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '11.0.0.1', '9.255.255.255', '126.255.255.255', '128.0.0.1', '223.255.255.255'];
  it.each(blocked)('refuses %s', (ip) => expect(isPublicIp(ip)).toBe(false));
  it.each(open)('accepts %s', (ip) => expect(isPublicIp(ip)).toBe(true));
  it('refuses anything that is not a plain address', () => {
    for (const x of ['', 'localhost', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', '1.2.3.-4', '1.2.3.4 ', '0x7f.0.0.1', '2130706433']) expect(isPublicIp(x), x).toBe(false);
  });
});

describe('isPublicIp: IPv6', () => {
  const blocked = [
    '::', '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd00:ec2::254', 'fdff::1', 'fec0::1', 'ff02::1', 'ff00::',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:192.168.1.1',
    '::127.0.0.1', '::7f00:1', // IPv4-compatible
    '64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b::169.254.169.254', // NAT64 of private IPv4
    '64:ff9b:1::1', // local-use NAT64
    '2002:7f00:1::', '2002:0a00:0001::1', '2002:808:808::1', // 6to4 is refused outright
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '2001:db8::1', '3fff::1', '100::1', '0:0:0:0:0:ffff:7f00:1', '::ffff:0:7f00:1',
    '1::1', '4000::1', 'e000::1', // outside 2000::/3 global unicast
  ];
  const open = ['2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:81b::200e', '64:ff9b::808:808', '::ffff:8.8.8.8', '::ffff:808:808'];
  it.each(blocked)('refuses %s', (ip) => expect(isPublicIp(ip)).toBe(false));
  it.each(open)('accepts %s', (ip) => expect(isPublicIp(ip)).toBe(true));
  it('refuses malformed IPv6', () => {
    for (const x of ['::1::', '1:2:3:4:5:6:7:8:9', 'gggg::1', '2606:4700:4700::1111%eth0', '[::1]', ':::', '2606:4700:4700::11111']) expect(isPublicIp(x), x).toBe(false);
  });
});

describe('assertPublicHttpsUrl', () => {
  const dns = () => fixed({ 'hooks.example.com': ['93.184.216.34'], 'v6.example.com': ['2606:4700:4700::1111'], 'both.example.com': ['93.184.216.34', '2606:4700:4700::1111'] });

  it('accepts https URLs whose every address is public, and returns the vetted addresses', async () => {
    await expect(assertPublicHttpsUrl('https://hooks.example.com/path?x=1', dns())).resolves.toBeUndefined();
    const r = await resolvePublicHttpsUrl('https://both.example.com:8443/h', dns());
    expect(r.addresses).toEqual(['93.184.216.34', '2606:4700:4700::1111']);
    expect(r.url.hostname).toBe('both.example.com');
    expect((await resolvePublicHttpsUrl('https://8.8.8.8/x', fixed({}))).addresses).toEqual(['8.8.8.8']);
    expect((await resolvePublicHttpsUrl('https://[2606:4700:4700::1111]/x', fixed({}))).addresses).toEqual(['2606:4700:4700::1111']);
  });

  it.each([
    'http://hooks.example.com/x',
    'ftp://hooks.example.com/x',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pw@hooks.example.com/x',
    'https://user@hooks.example.com/x',
    'https:///nohost',
    'not a url',
    '',
    `https://hooks.example.com/${'a'.repeat(2100)}`,
  ])('refuses the form %s', async (u) => {
    await expect(assertPublicHttpsUrl(u, dns())).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it.each([
    'https://127.0.0.1/x',
    'https://10.0.0.5/x',
    'https://192.168.1.1/x',
    'https://172.16.0.1/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://100.100.100.200/x',
    'https://0.0.0.0/x',
    'https://[::1]/x',
    'https://[::]/x',
    'https://[fe80::1]/x',
    'https://[fd00:ec2::254]/latest/meta-data/',
    'https://[::ffff:127.0.0.1]/x',
    'https://[::ffff:7f00:1]/x',
    'https://[::ffff:169.254.169.254]/x',
    'https://[64:ff9b::7f00:1]/x',
    // alternative spellings of loopback that the URL parser normalizes to a dotted address
    'https://2130706433/x',
    'https://0x7f000001/x',
    'https://0x7f.0.0.1/x',
    'https://017700000001/x',
    'https://127.1/x',
    'https://127.0.0.1./x',
    'https://0/x',
  ])('refuses the address literal %s', async (u) => {
    const dnsSpy = fixed({});
    await expect(assertPublicHttpsUrl(u, dnsSpy)).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it.each(['https://localhost/x', 'https://LOCALHOST/x', 'https://localhost./x', 'https://app.localhost/x', 'https://printer.local/x', 'https://metadata.google.internal/x', 'https://db.internal/x', 'https://x.localdomain/x', 'https://x.home.arpa/x'])(
    'refuses the reserved name %s without resolving it',
    async (u) => {
      const r = fixed({ localhost: ['93.184.216.34'], 'app.localhost': ['93.184.216.34'] });
      await expect(assertPublicHttpsUrl(u, r)).rejects.toBeInstanceOf(UrlRejectedError);
      expect(r.calls).toEqual([]);
    },
  );

  it('refuses a hostname that resolves to a private address, even if the name looks public', async () => {
    const r = fixed({ 'evil.example.com': ['10.1.2.3'], 'meta.example.com': ['169.254.169.254'], 'lo.example.com': ['127.0.0.1'], 'v6.example.com': ['::1'], 'mapped.example.com': ['::ffff:127.0.0.1'] });
    for (const h of ['evil', 'meta', 'lo', 'mapped']) await expect(assertPublicHttpsUrl(`https://${h}.example.com/x`, r)).rejects.toBeInstanceOf(UrlRejectedError);
    await expect(assertPublicHttpsUrl('https://v6.example.com/x', r)).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it('refuses when ANY resolved address is private (mixed answer)', async () => {
    const r = fixed({ 'mixed.example.com': ['93.184.216.34', '10.0.0.9'] });
    await expect(assertPublicHttpsUrl('https://mixed.example.com/x', r)).rejects.toThrow(/not public|private|reserved/i);
    const r2 = fixed({ 'mixed.example.com': ['10.0.0.9', '93.184.216.34'] });
    await expect(assertPublicHttpsUrl('https://mixed.example.com/x', r2)).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it('refuses a name that does not resolve and an empty answer', async () => {
    await expect(assertPublicHttpsUrl('https://nope.example.com/x', fixed({}))).rejects.toBeInstanceOf(UrlRejectedError);
    await expect(assertPublicHttpsUrl('https://empty.example.com/x', fixed({ 'empty.example.com': [] }))).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it('DNS rebinding: a name that is public at registration and private at delivery is refused the second time', async () => {
    let answer = ['93.184.216.34'];
    const rebinding: Resolver = async () => answer;
    await expect(assertPublicHttpsUrl('https://rebind.example.com/x', rebinding)).resolves.toBeUndefined(); // registration
    answer = ['127.0.0.1'];
    await expect(assertPublicHttpsUrl('https://rebind.example.com/x', rebinding)).rejects.toBeInstanceOf(UrlRejectedError); // delivery re-check
    answer = ['93.184.216.34', '169.254.169.254'];
    await expect(assertPublicHttpsUrl('https://rebind.example.com/x', rebinding)).rejects.toBeInstanceOf(UrlRejectedError);
  });

  it('the error never carries the resolver answer or credentials from the URL', async () => {
    const e = (await assertPublicHttpsUrl('https://user:secretpw@hooks.example.com/x', dns()).catch((x) => x)) as Error;
    expect(e).toBeInstanceOf(UrlRejectedError);
    expect(String(e.message)).not.toContain('secretpw');
  });
});
