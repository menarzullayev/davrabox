import { t, type Key, type Lang } from '../i18n';
import { fillTemplate, splitNames, type DayNames } from './logic';

/** Dictionary lookup with optional {placeholder} values. */
export function tx(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  const s = t(lang, key);
  return vars ? fillTemplate(s, vars) : s;
}

export function dayNames(lang: Lang): DayNames {
  return { weekdays: splitNames(t(lang, 'hWeekdays')), months: splitNames(t(lang, 'hMonths')), template: t(lang, 'hDayFormat') };
}
