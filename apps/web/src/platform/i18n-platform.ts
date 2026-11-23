// Strings that only appear inside the Android app. Merged into the main dictionaries by one spread line each in
// ../i18n.ts; key parity is enforced by the Record type below and by i18n.test.ts.
export const platformUz = {
  errMediaApp: 'Kamera yoki mikrofonga ruxsat berilmagan. Telefon sozlamalarida: Ilovalar, DavraBox, Ruxsatlar bo‘limida kamera va mikrofonni yoqing, so‘ng qayta urining.',
};

export type PlatformKey = keyof typeof platformUz;

export const platformRu: Record<PlatformKey, string> = {
  errMediaApp: 'Нет доступа к камере или микрофону. В настройках телефона откройте Приложения, DavraBox, Разрешения, включите камеру и микрофон и повторите попытку.',
};

export const platformEn: Record<PlatformKey, string> = {
  errMediaApp: 'Camera or microphone access is blocked. In your phone settings open Apps, DavraBox, Permissions, allow the camera and microphone, then try again.',
};
