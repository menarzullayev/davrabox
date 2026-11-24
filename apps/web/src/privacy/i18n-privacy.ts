// Strings around the public privacy/terms pages and the admin "Privacy" section. The legal texts themselves are structured documents
// in legal-privacy.ts / legal-terms.ts. Spread into the main dictionaries at the end of ../i18n.ts; key parity is enforced by the Record
// type there and by i18n.test.ts.
export const privacyUz = {
  privLegalNav: 'Huquqiy ma’lumotlar',
  privLinkPrivacy: 'Maxfiylik',
  privLinkTerms: 'Shartlar',
  privBackHome: 'DavraBox bosh sahifasi',
  privLangLabel: 'Til',
  privDraftLabel: 'Qoralama',
  privNavSections: 'Sahifa bo‘limlari',
  admPrivacy: 'Maxfiylik',
  admPrivIntro:
    'Foydalanuvchining shaxsiy ma’lumotlarini fayl ko‘rinishida yuklab oling yoki hisobini o‘chiring. O‘chirishda ism va elektron pochta neytral belgi bilan almashtiriladi, kirish hisobi, foydalanuvchi yuklagan fayllar va yozuvlar o‘chiriladi, API kalitlari bekor qilinadi. Audit jurnali saqlanadi, lekin endi shaxsga ishora qilmaydi. Amal qaytarilmaydi.',
  admPrivExport: 'Ma’lumotlarni yuklab olish',
  admPrivErase: 'O‘chirish',
  admPrivErased: 'O‘chirilgan',
  admPrivExportDone: '{name} ma’lumotlari yuklab olindi',
  admPrivEraseTitle: '{name} hisobini o‘chirish',
  admPrivEraseBody:
    'Ism va elektron pochta anonimlashtiriladi, kirish hisobi o‘chiriladi, foydalanuvchi yuklagan fayllar va yozuvlar o‘chiriladi, kalendar ulanishi uziladi va API kalitlari bekor qilinadi. Bu amalni qaytarib bo‘lmaydi.',
  admPrivEraseType: 'Tasdiqlash uchun hisobning elektron pochta manzilini kiriting ({email})',
  admPrivEraseGo: 'Butunlay o‘chirish',
  admPrivEraseDone: '{name} o‘chirildi',
  admPrivErrMismatch: 'Kiritilgan manzil hisob manziliga mos kelmadi',
  admPrivErrConflict: 'O‘chirib bo‘lmaydi: bu tashkilotning oxirgi administratori yoki uning yozuvi hali davom etmoqda',
  admPrivErrUpstream: 'Kirish xizmati yoki saqlash vaqtincha ishlamayapti. So‘rov saqlandi va avtomatik yakunlanadi; yana urinib ko‘rishingiz ham mumkin',
  admPrivErrGone: 'Bu hisob allaqachon o‘chirilgan',
};

export const privacyRu: Record<keyof typeof privacyUz, string> = {
  privLegalNav: 'Правовая информация',
  privLinkPrivacy: 'Конфиденциальность',
  privLinkTerms: 'Условия',
  privBackHome: 'На главную DavraBox',
  privLangLabel: 'Язык',
  privDraftLabel: 'Черновик',
  privNavSections: 'Разделы страницы',
  admPrivacy: 'Конфиденциальность',
  admPrivIntro:
    'Выгрузите персональные данные пользователя файлом или удалите его аккаунт. При удалении имя и адрес заменяются нейтральной меткой, аккаунт для входа, загруженные пользователем файлы и записи удаляются, ключи API отзываются. Журнал аудита сохраняется, но больше не указывает на человека. Действие необратимо.',
  admPrivExport: 'Выгрузить данные',
  admPrivErase: 'Удалить',
  admPrivErased: 'Удалён',
  admPrivExportDone: 'Данные {name} выгружены',
  admPrivEraseTitle: 'Удалить аккаунт {name}',
  admPrivEraseBody:
    'Имя и адрес электронной почты обезличиваются, аккаунт для входа удаляется, загруженные пользователем файлы и записи удаляются, подключение календаря отключается, ключи API отзываются. Это действие нельзя отменить.',
  admPrivEraseType: 'Для подтверждения введите адрес электронной почты аккаунта ({email})',
  admPrivEraseGo: 'Удалить безвозвратно',
  admPrivEraseDone: '{name}: аккаунт удалён',
  admPrivErrMismatch: 'Введённый адрес не совпадает с адресом аккаунта',
  admPrivErrConflict: 'Удалить нельзя: это последний администратор организации или его запись ещё идёт',
  admPrivErrUpstream: 'Служба входа или хранилище временно недоступны. Запрос сохранён и будет завершён автоматически; можно также повторить',
  admPrivErrGone: 'Этот аккаунт уже удалён',
};

export const privacyEn: Record<keyof typeof privacyUz, string> = {
  privLegalNav: 'Legal',
  privLinkPrivacy: 'Privacy',
  privLinkTerms: 'Terms',
  privBackHome: 'DavraBox home',
  privLangLabel: 'Language',
  privDraftLabel: 'Draft',
  privNavSections: 'Page sections',
  admPrivacy: 'Privacy',
  admPrivIntro:
    'Download a person\'s personal data as a file, or erase their account. Erasing replaces the name and e-mail address with a neutral label, deletes the sign-in account and the files and recordings the person uploaded, and revokes their API keys. The audit log is kept but no longer points to the person. This cannot be undone.',
  admPrivExport: 'Export data',
  admPrivErase: 'Erase',
  admPrivErased: 'Erased',
  admPrivExportDone: 'Data of {name} downloaded',
  admPrivEraseTitle: 'Erase the account of {name}',
  admPrivEraseBody:
    'The name and e-mail address are anonymised, the sign-in account is deleted, the files and recordings the person uploaded are deleted, the calendar connection is removed and their API keys are revoked. This cannot be undone.',
  admPrivEraseType: 'To confirm, type the e-mail address of this account ({email})',
  admPrivEraseGo: 'Erase permanently',
  admPrivEraseDone: '{name} was erased',
  admPrivErrMismatch: 'The address you typed does not match the account',
  admPrivErrConflict: 'Cannot erase: this is the last organization admin, or a recording they started is still running',
  admPrivErrUpstream: 'The sign-in service or storage is temporarily unavailable. The request is saved and will be finished automatically; you can also try again',
  admPrivErrGone: 'This account has already been erased',
};
