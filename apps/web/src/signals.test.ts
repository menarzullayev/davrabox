import { describe, expect, it } from 'vitest';
import { MAX_CHAT_LENGTH, REACTIONS, cleanChatText, decode, encode, parseRoomRecording } from './signals';

const raw = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

describe('cleanChatText', () => {
  it('trims and keeps normal text', () => expect(cleanChatText('  salom  ')).toBe('salom'));
  it('rejects empty and whitespace-only input', () => {
    expect(cleanChatText('')).toBeNull();
    expect(cleanChatText('   \n\t ')).toBeNull();
  });
  it('strips control characters but keeps newlines and tabs', () => {
    expect(cleanChatText('a\u0000b\u0007c\u007f')).toBe('abc');
    expect(cleanChatText('a\nb')).toBe('a\nb');
  });
  it('caps the length', () => expect(cleanChatText('x'.repeat(MAX_CHAT_LENGTH + 50))?.length).toBe(MAX_CHAT_LENGTH));
  it('does not interpret markup: it stays plain text for the renderer to escape', () => {
    expect(cleanChatText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('encode/decode round trip', () => {
  it('chat', () => expect(decode(encode({ t: 'chat', text: 'hi' }))).toEqual({ t: 'chat', text: 'hi' }));
  it('hand', () => expect(decode(encode({ t: 'hand', up: true }))).toEqual({ t: 'hand', up: true }));
  it.each(REACTIONS)('reaction %s', (e) => expect(decode(encode({ t: 'react', e }))).toEqual({ t: 'react', e }));
});

describe('decode rejects untrusted garbage', () => {
  it.each([
    ['empty payload', new Uint8Array(0)],
    ['not JSON', raw('not json')],
    ['JSON null', raw('null')],
    ['JSON array', raw([1, 2])],
    ['unknown type', raw({ t: 'admin', cmd: 'kick' })],
    ['chat without text', raw({ t: 'chat' })],
    ['chat with non-string text', raw({ t: 'chat', text: { a: 1 } })],
    ['blank chat', raw({ t: 'chat', text: '   ' })],
    ['hand with a string', raw({ t: 'hand', up: 'true' })],
    ['reaction outside the allowed set', raw({ t: 'react', e: '💣' })],
    ['reaction with markup', raw({ t: 'react', e: '<script>' })],
    ['oversized payload', raw({ t: 'chat', text: 'x'.repeat(9000) })],
  ])('%s', (_n, bytes) => expect(decode(bytes as Uint8Array)).toBeNull());

  it('ignores a forged sender field: it is never part of the result', () => {
    expect(decode(raw({ t: 'chat', text: 'hi', from: 'host', identity: 'x' }))).toEqual({ t: 'chat', text: 'hi' });
  });
  it('truncates an over-long chat instead of passing it on', () => {
    const s = decode(raw({ t: 'chat', text: 'y'.repeat(MAX_CHAT_LENGTH + 10) }));
    expect(s && s.t === 'chat' && s.text.length).toBe(MAX_CHAT_LENGTH);
  });
});

describe('file signal', () => {
  const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  it('round-trips and lower-cases the id', () => {
    expect(decode(raw({ t: 'file', id: id.toUpperCase(), name: 'a.pdf', size: 10 }))).toEqual({ t: 'file', id, name: 'a.pdf', size: 10 });
  });
  it.each([
    ['id is not a uuid', { t: 'file', id: '../../x', name: 'a', size: 1 }],
    ['id with a path', { t: 'file', id: `${id}/../x`, name: 'a', size: 1 }],
    ['empty name', { t: 'file', id, name: '  ', size: 1 }],
    ['name over 200 characters', { t: 'file', id, name: 'x'.repeat(201), size: 1 }],
    ['zero size', { t: 'file', id, name: 'a', size: 0 }],
    ['negative size', { t: 'file', id, name: 'a', size: -5 }],
    ['fractional size', { t: 'file', id, name: 'a', size: 1.5 }],
    ['size above the limit', { t: 'file', id, name: 'a', size: 26 * 1024 * 1024 }],
    ['size as a string', { t: 'file', id, name: 'a', size: '10' }],
  ])('rejects %s', (_n, v) => expect(decode(raw(v))).toBeNull());
});

describe('parseRoomRecording', () => {
  it('reads the consent flag the server sets in the room metadata', () => {
    expect(parseRoomRecording('{"recording":true}')).toBe(true);
    expect(parseRoomRecording('{"recording":true,"other":1}')).toBe(true);
    expect(parseRoomRecording('{}')).toBe(false);
  });
  it('treats anything unexpected as not recording', () => {
    for (const bad of [undefined, '', 'recording', 'null', '[]', '"x"', '{"recording":"true"}', '{"recording":1}', '{"recording":false}', '{', 'x'.repeat(5000)]) {
      expect(parseRoomRecording(bad), String(bad).slice(0, 20)).toBe(false);
    }
  });
});
