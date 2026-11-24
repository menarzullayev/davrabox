import { PRIVACY_CONTACT, type LegalTexts } from './legal-types';

// Privacy notice, plain language. Every statement of fact was taken from docs/privacy-data-inventory.md (checked against the schema and the code).
export const PRIVACY_TEXT: LegalTexts = {
  en: {
    title: 'Privacy notice',
    updated: 'Updated 24 November 2026',
    sections: [
      {
        id: 'who',
        heading: 'Who runs DavraBox',
        paragraphs: [
          'DavraBox is a video-conferencing service for organisations. The company that operates it and is responsible for your data: name, legal form, registration number and address are to be confirmed.',
          `Contact for privacy questions and requests: ${PRIVACY_CONTACT} (to be confirmed: the mailbox does not exist yet).`,
          'When your employer or school gives you an account, that organisation decides who may use DavraBox and can see parts of your data described below (its administrators). Ask your organisation about its own rules.',
        ],
      },
      {
        id: 'collect',
        heading: 'What we collect and why',
        items: [
          'Account: your name, e-mail address, role and department, and a sign-in identifier. Purpose: to let you sign in and to show your name to the people you meet with.',
          'Meetings: the title, code and time of meetings, who hosted them, and who entered them (including waiting-room requests). Purpose: to run meetings, host controls and file access.',
          'Guests: if you join a meeting without an account, we keep the name you typed and a keyed hash of your network address (not the address itself) for that meeting. Purpose: so that the host can admit you and can keep a removed person from coming back. They are deleted with the meeting.',
          'Audio, video and screen sharing: sent live through a media server while you are in a call. They are not stored unless the host starts a recording; a recording is announced to everyone in the meeting.',
          'Chat: messages travel live during the meeting and are not stored by DavraBox. In end-to-end encrypted meetings they are encrypted so that the server cannot read them.',
          'Files you share in a meeting: stored encrypted so that people in that meeting can download them.',
          'Calendar (only if you connect it): a refresh token of your Google or Microsoft calendar, stored encrypted, so that DavraBox can add meetings to your calendar. You can disconnect it at any time.',
          'Integrations created by your organisation: API keys and webhook addresses (the key secrets are stored only as a one-way hash).',
          'Security log: a record of important actions (who created a meeting, uploaded or downloaded a file, changed a setting). It exists for security and accountability and is visible to your organisation\'s administrators.',
          'Sign-up protection: when a free trial is requested, we keep a keyed hash of the e-mail address and of the network address and the e-mail domain, to limit abuse.',
          'We do not use advertising or analytics cookies and we load no third-party scripts. The browser stores your language and theme choice, and your sign-in session for the open tab.',
        ],
      },
      {
        id: 'retention',
        heading: 'How long we keep it',
        paragraphs: ['These are the default periods of the pilot. The operator can set shorter ones.'],
        items: [
          'Account: until the account is erased (see your rights). A free-trial organisation is deleted 30 days after its trial ends.',
          'Files shared in meetings: 90 days after upload, then deleted automatically.',
          'Recordings: 90 days after the meeting, then deleted automatically.',
          'Meeting information (title, code, who joined): 365 days after the meeting, then deleted automatically.',
          'Sign-up protection records: 90 days. A hash of the e-mail address is kept longer so that one address cannot start a free trial again and again.',
          'Identity-provider sign-in events: 90 days.',
          'Security log: kept. When a person is erased, the log keeps the actions but they no longer point to a name or an e-mail address.',
        ],
      },
      {
        id: 'rights',
        heading: 'Your rights',
        items: [
          'Access and copy: you can download the data DavraBox holds about you as a file. Your organisation\'s administrator can do the same for you.',
          'Erasure: you can have your account erased. Your name and e-mail address are replaced by a neutral label, your sign-in account is deleted, the files and recordings you uploaded and your calendar connection are deleted, and your API keys are revoked. The security log is kept without your identity. An organisation\'s last administrator cannot be erased until another administrator exists.',
          'Correction: ask your organisation\'s administrator, or write to the contact address.',
          'Questions and complaints: write to the contact address. You may also complain to the competent authority in Uzbekistan (to be confirmed).',
        ],
      },
      {
        id: 'subprocessors',
        heading: 'Who else processes data',
        paragraphs: [
          'LiveKit Cloud: during the pilot, audio, video and the in-call data of meetings pass through LiveKit Cloud, a hosted media service run by LiveKit, Inc., in a data centre outside Uzbekistan (region to be confirmed). LiveKit sees your user identifier, your display name and the media while you are in a call. DavraBox stores nothing at LiveKit. This will change when DavraBox runs its own media servers; this notice will then be updated.',
          'Hosting of the DavraBox servers: provider and country are to be confirmed.',
          'Google or Microsoft: only if you connect your calendar; they receive the calendar event DavraBox creates.',
          'Our sign-in service (Keycloak), the file scanner and the object storage run on DavraBox\'s own servers, not at a third party.',
        ],
      },
      {
        id: 'security',
        heading: 'How we protect it',
        paragraphs: [
          'Connections use TLS. Files and recordings are encrypted before they are stored, with a key per object. An organisation can bring its own encryption key (HashiCorp Vault). Meetings can be end-to-end encrypted. Each organisation\'s data is separated in the database. Backups are currently switched off, so a lost disk would lose data.',
        ],
      },
      {
        id: 'changes',
        heading: 'Changes',
        paragraphs: ['If we change this notice in a way that matters to you, we will say so on this page and in the app before it applies.'],
      },
    ],
  },
  ru: {
    title: 'Уведомление о конфиденциальности',
    updated: 'Обновлено 24 ноября 2026 г.',
    sections: [
      {
        id: 'who',
        heading: 'Кто предоставляет DavraBox',
        paragraphs: [
          'DavraBox — сервис видеоконференций для организаций. Компания, которая его предоставляет и отвечает за ваши данные: наименование, организационно-правовая форма, регистрационный номер и адрес уточняются.',
          `Контакт для вопросов и запросов о конфиденциальности: ${PRIVACY_CONTACT} (уточняется: такого ящика пока нет).`,
          'Если аккаунт вам выдал работодатель или учебное заведение, эта организация решает, кто пользуется DavraBox, и её администраторы видят часть описанных ниже данных. Правила организации узнавайте у неё.',
        ],
      },
      {
        id: 'collect',
        heading: 'Что мы собираем и зачем',
        items: [
          'Аккаунт: имя, адрес электронной почты, роль и отдел, идентификатор для входа. Цель: чтобы вы могли войти, а собеседники видели ваше имя.',
          'Встречи: название, код и время встречи, кто её провёл и кто в неё входил (включая запросы из зала ожидания). Цель: проведение встреч, права ведущего, доступ к файлам.',
          'Гости: если вы присоединяетесь к встрече без аккаунта, мы храним введённое вами имя и ключевой хеш вашего сетевого адреса (не сам адрес) для этой встречи. Цель: чтобы организатор мог вас впустить и не пускать удалённого человека обратно. Удаляются вместе со встречей.',
          'Звук, видео и показ экрана: передаются в реальном времени через медиасервер, пока вы на звонке. Не сохраняются, пока ведущий не начнёт запись; о записи объявляется всем участникам.',
          'Чат: сообщения идут в реальном времени во время встречи и DavraBox их не хранит. Во встречах со сквозным шифрованием они зашифрованы так, что сервер их прочитать не может.',
          'Файлы, которыми вы делитесь на встрече: хранятся в зашифрованном виде, чтобы участники этой встречи могли их скачать.',
          'Календарь (только если вы его подключили): токен обновления вашего календаря Google или Microsoft, в зашифрованном виде, чтобы DavraBox мог добавлять встречи в календарь. Отключить можно в любой момент.',
          'Интеграции, созданные вашей организацией: ключи API и адреса вебхуков (секреты ключей хранятся только в виде односторонней свёртки).',
          'Журнал безопасности: запись важных действий (кто создал встречу, загрузил или скачал файл, изменил настройку). Нужен для безопасности и подотчётности, виден администраторам вашей организации.',
          'Защита регистрации: при запросе бесплатного пробного периода мы храним ключевую свёртку адреса электронной почты и сетевого адреса, а также домен почты, чтобы ограничить злоупотребления.',
          'Мы не используем рекламные и аналитические cookie и не подключаем сторонние скрипты. Браузер хранит выбранный язык и тему, а также сессию входа в открытой вкладке.',
        ],
      },
      {
        id: 'retention',
        heading: 'Как долго мы это храним',
        paragraphs: ['Это сроки по умолчанию на время пилота. Оператор может установить более короткие.'],
        items: [
          'Аккаунт: до удаления аккаунта (см. «Ваши права»). Организация с бесплатным пробным периодом удаляется через 30 дней после его окончания.',
          'Файлы, которыми поделились на встречах: 90 дней после загрузки, затем удаляются автоматически.',
          'Записи: 90 дней после встречи, затем удаляются автоматически.',
          'Сведения о встрече (название, код, кто входил): 365 дней после встречи, затем удаляются автоматически.',
          'Записи защиты регистрации: 90 дней. Свёртка адреса электронной почты хранится дольше, чтобы один адрес не мог бесконечно запускать пробный период.',
          'События входа в службе идентификации: 90 дней.',
          'Журнал безопасности: сохраняется. Когда человека удаляют, журнал сохраняет действия, но они больше не указывают на имя или адрес электронной почты.',
        ],
      },
      {
        id: 'rights',
        heading: 'Ваши права',
        items: [
          'Доступ и копия: вы можете скачать файлом данные, которые DavraBox хранит о вас. То же для вас может сделать администратор вашей организации.',
          'Удаление: вы можете удалить свой аккаунт. Ваше имя и адрес заменяются нейтральной меткой, аккаунт для входа удаляется, загруженные вами файлы и записи и подключение календаря удаляются, ключи API отзываются. Журнал безопасности сохраняется без указания на вас. Последнего администратора организации удалить нельзя, пока нет другого администратора.',
          'Исправление: обратитесь к администратору вашей организации или по контактному адресу.',
          'Вопросы и жалобы: пишите на контактный адрес. Вы также можете обратиться в компетентный орган Узбекистана (уточняется).',
        ],
      },
      {
        id: 'subprocessors',
        heading: 'Кто ещё обрабатывает данные',
        paragraphs: [
          'LiveKit Cloud: в период пилота звук, видео и данные внутри звонка проходят через LiveKit Cloud — облачный медиасервис компании LiveKit, Inc. в дата-центре за пределами Узбекистана (регион уточняется). LiveKit видит ваш идентификатор пользователя, отображаемое имя и медиапотоки, пока вы на звонке. DavraBox ничего не хранит у LiveKit. Когда DavraBox запустит собственные медиасерверы, это изменится, и уведомление будет обновлено.',
          'Хостинг серверов DavraBox: провайдер и страна уточняются.',
          'Google или Microsoft: только если вы подключили календарь; они получают событие календаря, которое создаёт DavraBox.',
          'Служба входа (Keycloak), сканер файлов и объектное хранилище работают на серверах самого DavraBox, а не у третьей стороны.',
        ],
      },
      {
        id: 'security',
        heading: 'Как мы это защищаем',
        paragraphs: [
          'Соединения защищены TLS. Файлы и записи шифруются до сохранения, на каждый объект свой ключ. Организация может использовать собственный ключ шифрования (HashiCorp Vault). Встречи могут быть со сквозным шифрованием. Данные каждой организации разделены в базе данных. Резервные копии сейчас отключены, поэтому при потере диска данные будут потеряны.',
        ],
      },
      {
        id: 'changes',
        heading: 'Изменения',
        paragraphs: ['Если мы изменим это уведомление существенным для вас образом, мы сообщим об этом на этой странице и в приложении до вступления изменений в силу.'],
      },
    ],
  },
  uz: {
    title: 'Maxfiylik to‘g‘risida xabarnoma',
    updated: '2026-yil 24-noyabrda yangilangan',
    sections: [
      {
        id: 'who',
        heading: 'DavraBox’ni kim taqdim etadi',
        paragraphs: [
          'DavraBox — tashkilotlar uchun videokonferensiya xizmati. Uni taqdim etuvchi va ma’lumotlaringiz uchun mas’ul kompaniya: nomi, tashkiliy-huquqiy shakli, ro‘yxatdan o‘tish raqami va manzili aniqlanadi.',
          `Maxfiylik bo‘yicha savol va so‘rovlar uchun aloqa: ${PRIVACY_CONTACT} (aniqlanadi: bunday pochta qutisi hozircha yo‘q).`,
          'Hisobni sizga ish joyingiz yoki o‘quv muassasangiz bergan bo‘lsa, DavraBox’dan kim foydalanishini o‘sha tashkilot hal qiladi va uning administratorlari quyida tavsiflangan ma’lumotlarning bir qismini ko‘ra oladi. Tashkilotning o‘z qoidalarini undan so‘rang.',
        ],
      },
      {
        id: 'collect',
        heading: 'Nimalarni yig‘amiz va nima uchun',
        items: [
          'Hisob: ismingiz, elektron pochta manzilingiz, rolingiz va bo‘limingiz, kirish identifikatori. Maqsad: tizimga kirishingiz va suhbatdoshlaringiz ismingizni ko‘rishi uchun.',
          'Uchrashuvlar: uchrashuv nomi, kodi va vaqti, uni kim o‘tkazgani va kim kirgani (kutish xonasi so‘rovlari bilan). Maqsad: uchrashuvlarni o‘tkazish, boshlovchi boshqaruvi va fayllarga kirish.',
          'Mehmonlar: uchrashuvga hisobsiz qo‘shilsangiz, kiritgan ismingiz va tarmoq manzilingizning kalitli xeshi (manzilning o‘zi emas) shu uchrashuv uchun saqlanadi. Maqsad: host sizni kiritishi va chiqarilgan odam qaytib kirmasligi uchun. Uchrashuv bilan birga o‘chiriladi.',
          'Ovoz, video va ekranni ulashish: qo‘ng‘iroqda bo‘lganingizda media-server orqali jonli uzatiladi. Boshlovchi yozuvni boshlamasa, saqlanmaydi; yozuv haqida uchrashuvdagi hammaga e’lon qilinadi.',
          'Chat: xabarlar uchrashuv paytida jonli o‘tadi va DavraBox ularni saqlamaydi. Uchidan-uchiga shifrlangan (E2EE) uchrashuvlarda ular server o‘qiy olmaydigan tarzda shifrlanadi.',
          'Uchrashuvda ulashgan fayllaringiz: o‘sha uchrashuv ishtirokchilari yuklab olishi uchun shifrlangan holda saqlanadi.',
          'Kalendar (faqat siz ulasangiz): Google yoki Microsoft kalendaringizning yangilash tokeni, shifrlangan holda, DavraBox uchrashuvlarni kalendaringizga qo‘sha olishi uchun. Uni istalgan vaqt uzishingiz mumkin.',
          'Tashkilotingiz yaratgan integratsiyalar: API kalitlari va webhook manzillari (kalit sirlari faqat bir tomonlama xesh ko‘rinishida saqlanadi).',
          'Xavfsizlik jurnali: muhim amallar yozuvi (kim uchrashuv yaratdi, fayl yukladi yoki yuklab oldi, sozlamani o‘zgartirdi). U xavfsizlik va hisobdorlik uchun mavjud va tashkilotingiz administratorlariga ko‘rinadi.',
          'Ro‘yxatdan o‘tishni himoya qilish: bepul sinov so‘ralganda suiiste’molni cheklash uchun elektron pochta va tarmoq manzilining kalitli xeshi hamda pochta domenini saqlaymiz.',
          'Biz reklama va analitika cookie fayllaridan foydalanmaymiz va uchinchi tomon skriptlarini yuklamaymiz. Brauzer til va mavzu tanlovingizni hamda ochiq varaqdagi kirish seansini saqlaydi.',
        ],
      },
      {
        id: 'retention',
        heading: 'Qancha vaqt saqlaymiz',
        paragraphs: ['Bu — pilot davridagi standart muddatlar. Operator qisqaroq muddat belgilashi mumkin.'],
        items: [
          'Hisob: hisob o‘chirilgunga qadar (“Huquqlaringiz” bo‘limiga qarang). Bepul sinovdagi tashkilot sinov tugaganidan 30 kun o‘tgach o‘chiriladi.',
          'Uchrashuvlarda ulashilgan fayllar: yuklanganidan 90 kun o‘tgach avtomatik o‘chiriladi.',
          'Yozuvlar: uchrashuvdan 90 kun o‘tgach avtomatik o‘chiriladi.',
          'Uchrashuv ma’lumotlari (nomi, kodi, kim kirgani): uchrashuvdan 365 kun o‘tgach avtomatik o‘chiriladi.',
          'Ro‘yxatdan o‘tishni himoya qilish yozuvlari: 90 kun. Bir manzil bepul sinovni qayta-qayta boshlay olmasligi uchun elektron pochta xeshi uzoqroq saqlanadi.',
          'Identifikatsiya xizmatidagi kirish hodisalari: 90 kun.',
          'Xavfsizlik jurnali: saqlanadi. Shaxs o‘chirilganda jurnal amallarni saqlaydi, lekin ular endi ism yoki elektron pochtaga ishora qilmaydi.',
        ],
      },
      {
        id: 'rights',
        heading: 'Huquqlaringiz',
        items: [
          'Kirish va nusxa: DavraBox sizga oid saqlayotgan ma’lumotlarni fayl ko‘rinishida yuklab olishingiz mumkin. Tashkilotingiz administratori ham siz uchun buni qila oladi.',
          'O‘chirish: hisobingizni o‘chirtirishingiz mumkin. Ismingiz va elektron pochtangiz neytral belgi bilan almashtiriladi, kirish hisobingiz o‘chiriladi, siz yuklagan fayllar va yozuvlar hamda kalendar ulanishingiz o‘chiriladi, API kalitlaringiz bekor qilinadi. Xavfsizlik jurnali sizning shaxsingizsiz saqlanadi. Tashkilotning oxirgi administratorini boshqa administrator paydo bo‘lguncha o‘chirib bo‘lmaydi.',
          'Tuzatish: tashkilotingiz administratoriga yoki aloqa manziliga murojaat qiling.',
          'Savol va shikoyatlar: aloqa manziliga yozing. Shuningdek, O‘zbekistondagi vakolatli organga shikoyat qilishingiz mumkin (aniqlanadi).',
        ],
      },
      {
        id: 'subprocessors',
        heading: 'Ma’lumotlarni yana kim qayta ishlaydi',
        paragraphs: [
          'LiveKit Cloud: pilot davrida uchrashuvlarning ovozi, videosi va qo‘ng‘iroq ichidagi ma’lumotlari LiveKit, Inc. kompaniyasining O‘zbekistondan tashqaridagi ma’lumotlar markazida joylashgan bulutli media xizmati — LiveKit Cloud orqali o‘tadi (mintaqa aniqlanadi). Qo‘ng‘iroqda bo‘lganingizda LiveKit foydalanuvchi identifikatoringizni, ko‘rinadigan ismingizni va media oqimlarni ko‘radi. DavraBox LiveKit’da hech narsa saqlamaydi. DavraBox o‘z media-serverlarini ishga tushirganda bu o‘zgaradi va xabarnoma yangilanadi.',
          'DavraBox serverlarining hostingi: provayder va davlat aniqlanadi.',
          'Google yoki Microsoft: faqat kalendarni ulasangiz; ular DavraBox yaratgan kalendar tadbirini oladi.',
          'Kirish xizmati (Keycloak), fayl skaneri va obyekt ombori uchinchi tomonda emas, DavraBox’ning o‘z serverlarida ishlaydi.',
        ],
      },
      {
        id: 'security',
        heading: 'Qanday himoya qilamiz',
        paragraphs: [
          'Ulanishlar TLS bilan himoyalangan. Fayllar va yozuvlar saqlashdan oldin, har bir obyekt uchun alohida kalit bilan shifrlanadi. Tashkilot o‘z shifrlash kalitini (HashiCorp Vault) ishlatishi mumkin. Uchrashuvlar uchidan-uchiga shifrlangan (E2EE) bo‘lishi mumkin. Har bir tashkilotning ma’lumotlari bazada ajratilgan. Zaxira nusxalar hozircha o‘chirilgan, shuning uchun diskni yo‘qotish ma’lumotlarni yo‘qotishga olib keladi.',
        ],
      },
      {
        id: 'changes',
        heading: 'O‘zgarishlar',
        paragraphs: ['Ushbu xabarnomani siz uchun muhim tarzda o‘zgartirsak, o‘zgarish kuchga kirishidan oldin buni shu sahifada va ilovada ma’lum qilamiz.'],
      },
    ],
  },
};
