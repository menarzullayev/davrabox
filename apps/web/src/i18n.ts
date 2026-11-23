export type Lang = 'uz' | 'ru' | 'en';

const uz = {
  appName: 'DavraBox',
  signIn: 'Kirish',
  signOut: 'Chiqish',
  signingIn: 'Kirilmoqda…',
  meetings: 'Uchrashuvlar',
  newMeeting: 'Yangi uchrashuv',
  title: 'Mavzu',
  passcode: 'Parol (ixtiyoriy)',
  create: 'Yaratish',
  join: 'Qo‘shilish',
  joinByCode: 'Kod bo‘yicha qo‘shilish',
  code: 'Uchrashuv kodi',
  passcodeRequired: 'Parol',
  noMeetings: 'Hozircha uchrashuvlar yo‘q',
  mic: 'Mikrofon',
  camera: 'Kamera',
  share: 'Ekran ulashish',
  stopShare: 'Ulashishni to‘xtatish',
  leave: 'Chiqish',
  you: 'Siz',
  errWrongPasscode: 'Parol noto‘g‘ri',
  errNotFound: 'Uchrashuv topilmadi',
  errLocked: 'Uchrashuv qulflangan',
  errTooMany: 'Urinishlar ko‘p, keyinroq qayta urining',
  errGeneric: 'Xatolik yuz berdi',
  errMedia: 'Kamera yoki mikrofonga ruxsat berilmadi',
  hostBadge: 'Host',
  lang: 'Til',
} as const;

export type Key = keyof typeof uz;

const ru: Record<Key, string> = {
  appName: 'DavraBox',
  signIn: 'Войти',
  signOut: 'Выйти',
  signingIn: 'Выполняется вход…',
  meetings: 'Встречи',
  newMeeting: 'Новая встреча',
  title: 'Тема',
  passcode: 'Пароль (необязательно)',
  create: 'Создать',
  join: 'Присоединиться',
  joinByCode: 'Присоединиться по коду',
  code: 'Код встречи',
  passcodeRequired: 'Пароль',
  noMeetings: 'Пока нет встреч',
  mic: 'Микрофон',
  camera: 'Камера',
  share: 'Показать экран',
  stopShare: 'Остановить показ',
  leave: 'Выйти',
  you: 'Вы',
  errWrongPasscode: 'Неверный пароль',
  errNotFound: 'Встреча не найдена',
  errLocked: 'Встреча закрыта',
  errTooMany: 'Слишком много попыток, попробуйте позже',
  errGeneric: 'Произошла ошибка',
  errMedia: 'Нет доступа к камере или микрофону',
  hostBadge: 'Хост',
  lang: 'Язык',
};

const en: Record<Key, string> = {
  appName: 'DavraBox',
  signIn: 'Sign in',
  signOut: 'Sign out',
  signingIn: 'Signing in…',
  meetings: 'Meetings',
  newMeeting: 'New meeting',
  title: 'Title',
  passcode: 'Passcode (optional)',
  create: 'Create',
  join: 'Join',
  joinByCode: 'Join by code',
  code: 'Meeting code',
  passcodeRequired: 'Passcode',
  noMeetings: 'No meetings yet',
  mic: 'Microphone',
  camera: 'Camera',
  share: 'Share screen',
  stopShare: 'Stop sharing',
  leave: 'Leave',
  you: 'You',
  errWrongPasscode: 'Wrong passcode',
  errNotFound: 'Meeting not found',
  errLocked: 'Meeting is locked',
  errTooMany: 'Too many attempts, try again later',
  errGeneric: 'Something went wrong',
  errMedia: 'Camera or microphone access was denied',
  hostBadge: 'Host',
  lang: 'Language',
};

export const dictionaries: Record<Lang, Record<Key, string>> = { uz, ru, en };

export function t(lang: Lang, key: Key): string {
  return dictionaries[lang][key];
}

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem('lang');
    if (saved === 'uz' || saved === 'ru' || saved === 'en') return saved;
  } catch {
    /* storage unavailable */
  }
  const n = navigator.language.slice(0, 2);
  return n === 'ru' ? 'ru' : n === 'en' ? 'en' : 'uz';
}
