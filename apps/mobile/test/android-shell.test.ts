import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, '..', '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

async function loadConfig(appUrl?: string) {
  vi.resetModules();
  if (appUrl === undefined) vi.stubEnv('DAVRA_APP_URL', '');
  else vi.stubEnv('DAVRA_APP_URL', appUrl);
  return (await import('../capacitor.config')).default;
}

afterEach(() => vi.unstubAllEnvs());

describe('capacitor.config.ts', () => {
  it('uses the agreed app id and loads the hosted client over https', async () => {
    const c = await loadConfig();
    expect(c.appId).toBe('uz.davrabox.app');
    expect(c.server?.url).toBe('https://davrabox.bugvector.uz/app');
  });

  it('keeps cleartext traffic and mixed content off', async () => {
    const c = await loadConfig();
    expect(c.server?.cleartext).toBe(false);
    expect(c.android?.allowMixedContent).toBe(false);
    expect(c.android?.webContentsDebuggingEnabled).toBe(false);
  });

  it('limits navigation to the app host and nothing else', async () => {
    const c = await loadConfig();
    expect(c.server?.allowNavigation).toEqual(['davrabox.bugvector.uz']);
    const custom = await loadConfig('https://meet.example.org/app');
    expect(custom.server?.url).toBe('https://meet.example.org/app');
    expect(custom.server?.allowNavigation).toEqual(['meet.example.org']);
  });

  it.each(['http://meet.example.org/app', 'ftp://meet.example.org/', 'https://user:pw@meet.example.org/app', 'not a url'])(
    'refuses DAVRA_APP_URL=%s',
    async (bad) => {
      await expect(loadConfig(bad)).rejects.toThrow();
    },
  );
});

describe('AndroidManifest.xml', () => {
  const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const permissions = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map((m) => m[1]).sort();

  it('declares only the permissions a call needs', () => {
    expect(permissions).toEqual(
      [
        'android.permission.ACCESS_NETWORK_STATE',
        'android.permission.CAMERA',
        'android.permission.INTERNET',
        'android.permission.MODIFY_AUDIO_SETTINGS',
        'android.permission.RECORD_AUDIO',
      ].sort(),
    );
    expect(manifest).not.toMatch(/STORAGE|LOCATION|CONTACTS|READ_MEDIA|MANAGE_EXTERNAL/);
  });

  it('forbids cleartext traffic and backups', () => {
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    expect(manifest).toContain('android:allowBackup="false"');
  });

  it('has an auto-verified https App Links filter for /app on the configured host', () => {
    const filter = /<intent-filter android:autoVerify="true">([\s\S]*?)<\/intent-filter>/.exec(manifest)?.[1] ?? '';
    expect(filter).toContain('android.intent.action.VIEW');
    expect(filter).toContain('android.intent.category.BROWSABLE');
    expect(filter).toContain('android.intent.category.DEFAULT');
    expect(filter).toContain('android:scheme="https"');
    expect(filter).toContain('android:host="${davraHost}"');
    expect(filter).toContain('android:pathPrefix="/app"');
    expect(filter).not.toContain('android:scheme="http"');
  });

  it('does not export anything besides the launcher activity', () => {
    expect(manifest.match(/android:exported="true"/g)).toHaveLength(1);
  });
});

describe('Gradle project', () => {
  const app = read('android', 'app', 'build.gradle');
  const vars = read('android', 'variables.gradle');
  const docs = readFileSync(join(repo, 'docs', 'android.md'), 'utf8');

  it('uses the agreed application id and feeds the host placeholder from DAVRA_APP_URL', () => {
    expect(app).toContain('applicationId "uz.davrabox.app"');
    expect(app).toContain("System.getenv('DAVRA_APP_URL')");
    expect(app).toContain('manifestPlaceholders = [davraHost: davraUri.host]');
  });

  it('documents the SDK levels it builds with', () => {
    const min = /minSdkVersion = (\d+)/.exec(vars)?.[1];
    const target = /targetSdkVersion = (\d+)/.exec(vars)?.[1];
    expect(min).toBeDefined();
    expect(target).toBeDefined();
    expect(docs).toContain(`minSdk ${min}`);
    expect(docs).toContain(`targetSdk ${target}`);
  });

  it('pins Capacitor to exact versions that match each other', () => {
    const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const versions = [pkg.dependencies['@capacitor/android'], pkg.dependencies['@capacitor/core'], pkg.devDependencies['@capacitor/cli']];
    for (const v of versions) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(versions).size).toBe(1);
  });

  it('keeps signing material out of the tree', () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(jks|keystore|p12|pfx|pem|key)$/i.test(name) || name === 'keystore.properties') bad.push(p);
      }
    };
    walk(join(root, 'android'));
    expect(bad).toEqual([]);
    expect(app).not.toMatch(/storePassword\s+['"]/);
    expect(existsSync(join(root, 'android', 'app', 'src', 'main', 'java', 'uz', 'davrabox', 'app', 'MainActivity.java'))).toBe(true);
  });
});
