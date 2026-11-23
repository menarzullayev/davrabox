// Organization slug from a free-text name. The result always satisfies the database rule ^[a-z0-9][a-z0-9-]{1,47}$
// (create_trial_org adds a numeric suffix when the slug is taken) and is never a reserved word.

export const RESERVED_SLUGS: readonly string[] = [
  'admin', 'api', 'app', 'www', 'auth', 'demo', 'status',
  'login', 'signup', 'static', 'assets', 'mail', 'support', 'help', 'root', 'system', 'davrabox', 'dashboard', 'internal', 'billing',
];

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya', ў: 'u', қ: 'q', ғ: 'g', ҳ: 'h',
};

const MAX_LEN = 48;

export function slugify(name: string): string {
  let s = name.toLowerCase().replace(/[а-яёўқғҳ]/g, (c) => CYRILLIC[c] ?? '');
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/['`’‘ʻʼ´]/g, ''); // O‘zbekiston -> ozbekiston
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  s = s.slice(0, MAX_LEN).replace(/-+$/g, '');
  if (s.length === 0) s = 'org';
  if (s.length < 2) s = `${s}-org`;
  if (RESERVED_SLUGS.includes(s)) s = `${s}-org`;
  return s;
}
