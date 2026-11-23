// End-to-end encryption strings (Uzbek, Russian, English). Merged into the main dictionaries with one spread line per
// language in ../i18n.ts; key parity is enforced by the shared type and by i18n.test.ts.
export const e2eeUz = {
  e2eeToggle: 'Uchidan-uchiga shifrlash (E2EE)',
  e2eeToggleHint:
    'Video, ovoz va chat faqat havoladagi kalit bilan ochiladi; server ularni ko‘ra olmaydi. Yozib olish va fayl almashish o‘chiriladi, tashkilot administratori ham mazmunni ko‘ra olmaydi. Keyin o‘zgartirib bo‘lmaydi.',
  e2eeBadge: 'E2EE',
  e2eeBadgeHint: 'Uchrashuv uchidan-uchiga shifrlangan',
  e2eeRowBadge: 'Shifrlangan',
  e2eeAnnOn: 'Uchidan-uchiga shifrlash yoqilgan',
  e2eeLinkTitle: 'Shifrlangan uchrashuv havolasi',
  e2eeLinkLead:
    'Kalit havolaning # belgisidan keyingi qismida va hech qachon serverga yuborilmaydi. Havolani faqat ishonchli kanal orqali yuboring: havolaga ega har bir kishi uchrashuvni ocha oladi.',
  e2eeLinkLabel: 'To‘liq havola (kalit bilan)',
  e2eeLinkCopy: 'Havolani nusxalash',
  e2eeLinkCopied: 'Nusxalandi',
  e2eeLinkNoKey: 'Bu brauzerda uchrashuv kaliti yo‘q, shuning uchun havola kalitsiz nusxalandi. Kalitli havolani uchrashuvni yaratgan kishidan so‘rang.',
  e2eeLinkClose: 'Tayyor',
  e2eeGateTitle: 'Bu uchrashuv shifrlangan',
  e2eeGateBody:
    'Kirish uchun kalitli to‘liq havola kerak. Kalitsiz video va ovozni ochib bo‘lmaydi, shuning uchun hozircha ulanmadik. Uchrashuv egasidan to‘liq havolani so‘rang va uni quyiga qo‘ying.',
  e2eeGateLabel: 'To‘liq havola yoki kalit',
  e2eeGateSubmit: 'Kalitni qo‘llash va kirish',
  e2eeGateInvalid: 'Bu havolada to‘g‘ri kalit topilmadi. Havola # belgisidan keyin k=… qismini o‘z ichiga olishi kerak.',
  e2eeGateLeave: 'Chiqish',
  e2eeUnsupported: 'Brauzeringiz shifrlangan uchrashuvlarni qo‘llab-quvvatlamaydi. Chrome, Edge, Firefox yoki Safari ning yangi versiyasidan foydalaning.',
  e2eeWrongKey: 'Ba’zi ishtirokchilarning video va ovozini ochib bo‘lmadi. Kalit noto‘g‘ri yoki eskirgan bo‘lishi mumkin: egasidan yangi havolani so‘rang.',
  e2eeNoFiles: 'Shifrlangan uchrashuvda fayl almashish o‘chirilgan: fayllar server orqali o‘tadi.',
};

export const e2eeRu: Record<keyof typeof e2eeUz, string> = {
  e2eeToggle: 'Сквозное шифрование (E2EE)',
  e2eeToggleHint:
    'Видео, звук и чат открываются только ключом из ссылки; сервер их не видит. Запись и обмен файлами отключаются, содержимое не видит и администратор организации. Позже изменить нельзя.',
  e2eeBadge: 'E2EE',
  e2eeBadgeHint: 'Встреча защищена сквозным шифрованием',
  e2eeRowBadge: 'Зашифрована',
  e2eeAnnOn: 'Сквозное шифрование включено',
  e2eeLinkTitle: 'Ссылка на зашифрованную встречу',
  e2eeLinkLead:
    'Ключ находится в части ссылки после знака # и никогда не отправляется на сервер. Передавайте ссылку только по надёжному каналу: любой, у кого она есть, может войти во встречу.',
  e2eeLinkLabel: 'Полная ссылка (с ключом)',
  e2eeLinkCopy: 'Копировать ссылку',
  e2eeLinkCopied: 'Скопировано',
  e2eeLinkNoKey: 'В этом браузере нет ключа встречи, поэтому ссылка скопирована без ключа. Попросите ссылку с ключом у создателя встречи.',
  e2eeLinkClose: 'Готово',
  e2eeGateTitle: 'Эта встреча зашифрована',
  e2eeGateBody:
    'Для входа нужна полная ссылка с ключом. Без ключа видео и звук не расшифровать, поэтому мы не подключались. Попросите у организатора полную ссылку и вставьте её ниже.',
  e2eeGateLabel: 'Полная ссылка или ключ',
  e2eeGateSubmit: 'Применить ключ и войти',
  e2eeGateInvalid: 'В этой ссылке не найден корректный ключ. После знака # должна идти часть k=…',
  e2eeGateLeave: 'Выйти',
  e2eeUnsupported: 'Ваш браузер не поддерживает зашифрованные встречи. Используйте свежую версию Chrome, Edge, Firefox или Safari.',
  e2eeWrongKey: 'Видео и звук некоторых участников не удалось расшифровать. Возможно, ключ неверный или устарел: попросите у организатора новую ссылку.',
  e2eeNoFiles: 'В зашифрованной встрече обмен файлами отключён: файлы проходят через сервер.',
};

export const e2eeEn: Record<keyof typeof e2eeUz, string> = {
  e2eeToggle: 'End-to-end encryption (E2EE)',
  e2eeToggleHint:
    'Video, audio and chat open only with the key in the link; the server cannot see them. Recording and file sharing are turned off, and your organisation admin cannot see the content either. It cannot be changed later.',
  e2eeBadge: 'E2EE',
  e2eeBadgeHint: 'This meeting is end-to-end encrypted',
  e2eeRowBadge: 'Encrypted',
  e2eeAnnOn: 'End-to-end encryption is on',
  e2eeLinkTitle: 'Link to the encrypted meeting',
  e2eeLinkLead:
    'The key is the part of the link after the # sign and is never sent to any server. Share the link only over a channel you trust: everyone who has it can open the meeting.',
  e2eeLinkLabel: 'Full link (with the key)',
  e2eeLinkCopy: 'Copy link',
  e2eeLinkCopied: 'Copied',
  e2eeLinkNoKey: 'This browser does not hold the meeting key, so the link was copied without it. Ask the person who created the meeting for the link with the key.',
  e2eeLinkClose: 'Done',
  e2eeGateTitle: 'This meeting is encrypted',
  e2eeGateBody:
    'You need the full link with the key to enter. Without it video and audio cannot be decrypted, so we did not connect. Ask the organiser for the full link and paste it below.',
  e2eeGateLabel: 'Full link or key',
  e2eeGateSubmit: 'Use this key and join',
  e2eeGateInvalid: 'No valid key was found in that text. The link must contain k=… after the # sign.',
  e2eeGateLeave: 'Leave',
  e2eeUnsupported: 'Your browser does not support encrypted meetings. Use a current version of Chrome, Edge, Firefox or Safari.',
  e2eeWrongKey: 'Some participants’ video and audio could not be decrypted. The key may be wrong or out of date: ask the organiser for a new link.',
  e2eeNoFiles: 'File sharing is turned off in an encrypted meeting: files would pass through the server.',
};
