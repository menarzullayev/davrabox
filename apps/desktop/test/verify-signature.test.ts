import { describe, expect, it } from 'vitest';
import { UsageError, parseArgs, planVerification } from '../scripts/verify-signature.mjs';

describe('parseArgs', () => {
  it('requires exactly one file', () => {
    expect(() => parseArgs([])).toThrow(UsageError);
    expect(() => parseArgs(['a.exe', 'b.exe'])).toThrow(UsageError);
  });
  it('rejects unknown flags and a flag without value', () => {
    expect(() => parseArgs(['--nope', 'a.exe'])).toThrow(UsageError);
    expect(() => parseArgs(['a.exe', '--platform'])).toThrow(UsageError);
    expect(() => parseArgs(['a.exe', '--platform', 'plan9'])).toThrow(UsageError);
  });
  it('accepts a file and an optional platform', () => {
    expect(parseArgs(['a.exe'])).toEqual({ file: 'a.exe', platform: undefined });
    expect(parseArgs(['--platform', 'mac', 'A.app'])).toEqual({ file: 'A.app', platform: 'mac' });
  });
});

describe('planVerification', () => {
  it('Windows executables are checked with signtool', () => {
    const plan = planVerification('release/DavraBox Setup.exe', 'win');
    expect(plan[0]?.command).toBe('signtool');
    expect(plan[0]?.args).toEqual(['verify', '/pa', '/all', '/v', 'release/DavraBox Setup.exe']);
  });
  it('macOS bundles are checked with codesign, spctl and stapler', () => {
    const plan = planVerification('release/mac/DavraBox.app', 'mac');
    expect(plan.map((s) => s.command)).toEqual(['codesign', 'spctl', 'xcrun']);
    expect(plan[0]?.args).toContain('--strict');
    expect(plan[1]?.args).toEqual(['--assess', '--type', 'execute', '-vv', 'release/mac/DavraBox.app']);
  });
  it('dmg images use the open assessment', () => {
    const plan = planVerification('DavraBox.dmg', 'mac');
    expect(plan[1]?.args).toContain('open');
  });
  it('refuses file types with no defined check instead of passing them', () => {
    expect(() => planVerification('DavraBox.AppImage', 'linux')).toThrow(UsageError);
    expect(() => planVerification('notes.txt', 'win')).toThrow(UsageError);
  });
  it('refuses a platform that cannot check this artifact', () => {
    expect(() => planVerification('x.exe', 'mac')).toThrow(UsageError);
    expect(() => planVerification('x.app', 'win')).toThrow(UsageError);
  });
});
