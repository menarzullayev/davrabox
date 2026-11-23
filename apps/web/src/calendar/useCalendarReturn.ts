import { useEffect } from 'react';
import { t, type Key, type Lang } from '../i18n';
import type { ToastInput } from '../ui';
import { returnNotice, stripReturnParams } from './logic';

const KEY: Record<'connected' | 'denied' | 'error', Key> = {
  connected: 'calReturnConnected',
  denied: 'calReturnDenied',
  error: 'calReturnError',
};

/**
 * The API's OAuth callback sends the browser back to the app with `?calendar=connected&provider=google`. Show the
 * result once and remove those parameters from the address (other parameters such as ?join= stay).
 */
export function useCalendarReturn(lang: Lang, toast: (input: ToastInput) => void): void {
  useEffect(() => {
    const notice = returnNotice(window.location.search);
    if (!notice) return;
    toast({ tone: notice.kind === 'connected' ? 'success' : 'danger', title: t(lang, KEY[notice.kind]) });
    const clean = window.location.pathname + stripReturnParams(window.location.search) + window.location.hash;
    window.history.replaceState(null, '', clean);
    // once per page load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
