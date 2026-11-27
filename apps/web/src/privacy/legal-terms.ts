import { PRIVACY_CONTACT, type LegalTexts } from './legal-types';

// Terms of use, plain language.
export const TERMS_TEXT: LegalTexts = {
  en: {
    title: 'Terms of use',
    updated: 'Updated 24 November 2026',
    sections: [
      {
        id: 'service',
        heading: 'The service',
        paragraphs: [
          'DavraBox lets organisations hold video meetings, share files in a meeting and, when the host chooses, record it. The operator of the service (name, legal form and address: to be confirmed) is called "we" here.',
          'The service is in a pilot. It is provided as it is, without a promise of uninterrupted availability. Backups are currently switched off, so keep your own copy of anything you cannot lose.',
        ],
      },
      {
        id: 'accounts',
        heading: 'Accounts and organisations',
        items: [
          'An account belongs to one organisation. The organisation\'s administrators decide who has an account, their role and the organisation\'s settings, and can see the security log and export or erase the data of their members.',
          'Keep your sign-in details to yourself. You are responsible for what happens under your account.',
          'A free trial lasts 7 days with the limits shown on the sign-up page. After it ends you cannot create or join meetings. The organisation and its data are deleted 30 days after the trial ends.',
        ],
      },
      {
        id: 'use',
        heading: 'Acceptable use',
        items: [
          'Do not use DavraBox for anything unlawful, to harass people, to send malware, or to attack or overload the service.',
          'Do not try to get into other organisations\' data or to get around limits or security.',
          'Files are scanned for malware; a file that is rejected is not stored.',
        ],
      },
      {
        id: 'meetings',
        heading: 'Meetings, recordings and what you share',
        items: [
          'You remain responsible for what you say, show and share in a meeting.',
          'A host may record a meeting. Everyone in the meeting sees a recording indicator. If you do not agree to be recorded, leave the meeting. Hosts must make sure they are allowed to record and must follow the rules that apply to them.',
          'Meetings can be end-to-end encrypted. Then the server cannot read the content, recording and file sharing are switched off, and we cannot recover a lost link key.',
        ],
      },
      {
        id: 'data',
        heading: 'Your data',
        paragraphs: ['What we do with personal data is described in the privacy notice. You keep your rights over what you upload. You give us the permission needed to store, transmit and show it to the people you choose, only to run the service.'],
      },
      {
        id: 'liability',
        heading: 'Liability and warranties',
        paragraphs: ['The limits of our liability, warranty wording and any service-level terms are set out by the operator. Nothing in these terms limits rights that the law does not allow to be limited.'],
      },
      {
        id: 'ending',
        heading: 'Ending',
        paragraphs: ['You can stop using DavraBox at any time and ask for your account to be erased. We may suspend an account that breaks these terms or puts the service or other people at risk.'],
      },
      {
        id: 'law',
        heading: 'Governing law and contact',
        paragraphs: [
          'Governing law and the way disputes are settled: to be confirmed (the law of the Republic of Uzbekistan is intended).',
          `Contact: ${PRIVACY_CONTACT}.`,
          'We may change these terms. If a change matters to you we will say so on this page and in the app before it applies.',
        ],
      },
    ],
  },
  ru: {
    title: 'Условия использования',
    updated: 'Обновлено 24 ноября 2026 г.',
    sections: [
      {
        id: 'service',
        heading: 'Сервис',
        paragraphs: [
          'DavraBox позволяет организациям проводить видеовстречи, делиться файлами во встрече и, по решению ведущего, записывать её. Оператор сервиса (наименование, организационно-правовая форма и адрес уточняются) далее называется «мы».',
          'Сервис работает в режиме пилота. Он предоставляется «как есть», без обещания бесперебойной доступности. Резервные копии сейчас отключены, поэтому храните свою копию всего, что нельзя потерять.',
        ],
      },
      {
        id: 'accounts',
        heading: 'Аккаунты и организации',
        items: [
          'Аккаунт принадлежит одной организации. Администраторы организации решают, у кого есть аккаунт, какая у него роль и какие настройки у организации; они видят журнал безопасности и могут выгрузить или удалить данные своих участников.',
          'Не передавайте свои данные для входа. Вы отвечаете за то, что происходит под вашим аккаунтом.',
          'Бесплатный пробный период длится 7 дней с ограничениями, указанными на странице регистрации. После его окончания создавать встречи и входить в них нельзя. Организация и её данные удаляются через 30 дней после окончания пробного периода.',
        ],
      },
      {
        id: 'use',
        heading: 'Допустимое использование',
        items: [
          'Не используйте DavraBox для незаконных целей, для преследования людей, рассылки вредоносных программ, а также для атак на сервис и его перегрузки.',
          'Не пытайтесь получить доступ к данным других организаций и обойти ограничения или защиту.',
          'Файлы проверяются на вредоносное ПО; отклонённый файл не сохраняется.',
        ],
      },
      {
        id: 'meetings',
        heading: 'Встречи, записи и то, чем вы делитесь',
        items: [
          'Вы отвечаете за то, что говорите, показываете и передаёте во встрече.',
          'Ведущий может записывать встречу. Все участники видят индикатор записи. Если вы не согласны на запись, покиньте встречу. Ведущие должны убедиться, что вправе записывать, и соблюдать применимые к ним правила.',
          'Встречи могут быть со сквозным шифрованием. Тогда сервер не может прочитать содержимое, запись и обмен файлами отключены, а потерянный ключ из ссылки мы восстановить не можем.',
        ],
      },
      {
        id: 'data',
        heading: 'Ваши данные',
        paragraphs: ['Что мы делаем с персональными данными, описано в уведомлении о конфиденциальности. Права на загруженное вами остаются за вами. Вы даёте нам разрешение, необходимое, чтобы хранить, передавать и показывать это выбранным вами людям, и только для работы сервиса.'],
      },
      {
        id: 'liability',
        heading: 'Ответственность и гарантии',
        paragraphs: ['Пределы нашей ответственности, формулировки гарантий и условия уровня сервиса определяются оператором. Ничто в этих условиях не ограничивает права, которые закон не позволяет ограничивать.'],
      },
      {
        id: 'ending',
        heading: 'Прекращение',
        paragraphs: ['Вы можете в любой момент перестать пользоваться DavraBox и попросить удалить аккаунт. Мы можем приостановить аккаунт, нарушающий эти условия или создающий риск для сервиса или других людей.'],
      },
      {
        id: 'law',
        heading: 'Применимое право и контакты',
        paragraphs: [
          'Применимое право и порядок разрешения споров: уточняются (предполагается право Республики Узбекистан).',
          `Контакт: ${PRIVACY_CONTACT}.`,
          'Мы можем изменить эти условия. Если изменение существенно для вас, мы сообщим об этом на этой странице и в приложении до вступления в силу.',
        ],
      },
    ],
  },
  uz: {
    title: 'Foydalanish shartlari',
    updated: '2026-yil 24-noyabrda yangilangan',
    sections: [
      {
        id: 'service',
        heading: 'Xizmat',
        paragraphs: [
          'DavraBox tashkilotlarga video uchrashuvlar o‘tkazish, uchrashuvda fayl ulashish va boshlovchi xohlasa, uni yozib olish imkonini beradi. Xizmat operatori (nomi, tashkiliy-huquqiy shakli va manzili aniqlanadi) bu yerda “biz” deb ataladi.',
          'Xizmat pilot rejimida ishlamoqda. U “borligicha” taqdim etiladi, uzluksiz ishlashga va’da berilmaydi. Zaxira nusxalar hozircha o‘chirilgan, shuning uchun yo‘qotib bo‘lmaydigan narsaning o‘z nusxasini saqlang.',
        ],
      },
      {
        id: 'accounts',
        heading: 'Hisoblar va tashkilotlar',
        items: [
          'Hisob bitta tashkilotga tegishli. Tashkilot administratorlari kimda hisob borligini, uning rolini va tashkilot sozlamalarini hal qiladi; ular xavfsizlik jurnalini ko‘ra oladi va a’zolarining ma’lumotlarini yuklab olishi yoki o‘chirishi mumkin.',
          'Kirish ma’lumotlaringizni boshqalarga bermang. Hisobingiz ostida sodir bo‘lgan narsalar uchun siz javobgarsiz.',
          'Bepul sinov 7 kun davom etadi va ro‘yxatdan o‘tish sahifasida ko‘rsatilgan cheklovlarga ega. U tugagach, uchrashuv yaratib yoki unga kirib bo‘lmaydi. Tashkilot va uning ma’lumotlari sinov tugaganidan 30 kun o‘tgach o‘chiriladi.',
        ],
      },
      {
        id: 'use',
        heading: 'Ruxsat etilgan foydalanish',
        items: [
          'DavraBox’dan qonunga xilof maqsadlarda, odamlarni ta’qib qilish, zararli dastur yuborish, shuningdek xizmatga hujum qilish yoki uni ortiqcha yuklash uchun foydalanmang.',
          'Boshqa tashkilotlar ma’lumotlariga kirishga yoki cheklov va himoyani aylanib o‘tishga urinmang.',
          'Fayllar zararli dasturga tekshiriladi; rad etilgan fayl saqlanmaydi.',
        ],
      },
      {
        id: 'meetings',
        heading: 'Uchrashuvlar, yozuvlar va siz ulashgan narsalar',
        items: [
          'Uchrashuvda aytgan, ko‘rsatgan va ulashgan narsalaringiz uchun siz javobgarsiz.',
          'Boshlovchi uchrashuvni yozib olishi mumkin. Uchrashuvdagi hamma yozuv belgisini ko‘radi. Yozib olinishga rozi bo‘lmasangiz, uchrashuvni tark eting. Boshlovchilar yozib olishga haqlari borligiga ishonch hosil qilishi va o‘ziga tegishli qoidalarga amal qilishi shart.',
          'Uchrashuvlar uchidan-uchiga shifrlangan (E2EE) bo‘lishi mumkin. Unda server mazmunni o‘qiy olmaydi, yozib olish va fayl almashish o‘chirilgan, yo‘qotilgan havola kalitini esa biz tiklay olmaymiz.',
        ],
      },
      {
        id: 'data',
        heading: 'Ma’lumotlaringiz',
        paragraphs: ['Shaxsiy ma’lumotlar bilan nima qilishimiz maxfiylik to‘g‘risidagi xabarnomada tasvirlangan. Yuklagan narsangizga bo‘lgan huquqlar o‘zingizda qoladi. Siz bizga uni saqlash, uzatish va siz tanlagan odamlarga ko‘rsatish uchun zarur ruxsatni berasiz, faqat xizmat ishlashi uchun.'],
      },
      {
        id: 'liability',
        heading: 'Javobgarlik va kafolatlar',
        paragraphs: ['Javobgarligimiz chegaralari, kafolat ifodalari va xizmat darajasi shartlari operator tomonidan belgilanadi. Ushbu shartlardagi hech narsa qonun cheklashga yo‘l qo‘ymaydigan huquqlarni cheklamaydi.'],
      },
      {
        id: 'ending',
        heading: 'Tugatish',
        paragraphs: ['DavraBox’dan istalgan vaqt foydalanishni to‘xtatib, hisobingizni o‘chirishni so‘rashingiz mumkin. Ushbu shartlarni buzgan yoki xizmat yoki boshqa odamlarga xavf tug‘diradigan hisobni to‘xtatib qo‘yishimiz mumkin.'],
      },
      {
        id: 'law',
        heading: 'Qo‘llaniladigan huquq va aloqa',
        paragraphs: [
          'Qo‘llaniladigan huquq va nizolarni hal etish tartibi: aniqlanadi (O‘zbekiston Respublikasi huquqi nazarda tutilmoqda).',
          `Aloqa: ${PRIVACY_CONTACT}.`,
          'Biz bu shartlarni o‘zgartirishimiz mumkin. O‘zgarish siz uchun muhim bo‘lsa, kuchga kirishidan oldin buni shu sahifada va ilovada ma’lum qilamiz.',
        ],
      },
    ],
  },
};
