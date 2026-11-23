import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button, IconCheckCircle, TextField } from '../ui';
import type { Lang } from '../i18n';
import { formatCode, parseJoinInput, type JoinInvalidReason } from './logic';
import { tx } from './text';

export interface JoinCardHandle {
  /** Fills the code field and moves focus to the passcode field with an explanation (a protected meeting). */
  askPasscode: (code: string) => void;
}

export interface JoinCardProps {
  lang: Lang;
  initialCode?: string;
  onJoin: (code: string, passcode?: string) => Promise<void>;
}

const REASON_KEY = { notCode: 'hJoinErrNotCode', tooLong: 'hJoinErrTooLong', noCodeInLink: 'hJoinErrNoCode' } as const satisfies Record<JoinInvalidReason, string>;

/**
 * The primary area of the home screen: join by code or by pasted link, with instant validation.
 * The form keeps exactly one button and one numeric input (apps/e2e drives it by `form[data-testid=join-form]`).
 */
export const JoinCard = forwardRef<JoinCardHandle, JoinCardProps>(function JoinCard({ lang, initialCode = '', onJoin }, ref) {
  const [value, setValue] = useState(() => (initialCode ? formatCode(initialCode) : ''));
  const [pass, setPass] = useState('');
  const [touched, setTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [fromLink, setFromLink] = useState(false);
  const [passNote, setPassNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const passRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    askPasscode: (code) => {
      setValue(formatCode(code));
      setFromLink(false);
      setPassNote(true);
      setTouched(true);
      requestAnimationFrame(() => passRef.current?.focus());
    },
  }));

  const parsed = useMemo(() => parseJoinInput(value), [value]);

  const errorText = (() => {
    if (parsed.status === 'invalid') {
      // Clearly wrong input is flagged at once; a half-typed link only once the field is left or submitted.
      if (parsed.reason !== 'noCodeInLink' || touched || attempted) return tx(lang, REASON_KEY[parsed.reason]);
      return null;
    }
    if (attempted && parsed.status === 'empty') return tx(lang, 'hJoinErrEmpty');
    if (attempted && parsed.status === 'incomplete') return tx(lang, 'hJoinErrShort');
    return null;
  })();

  const okText = parsed.status === 'valid' ? tx(lang, fromLink ? 'hJoinFromLink' : 'hJoinOk', { code: formatCode(parsed.code) }) : null;
  const hint = parsed.status === 'incomplete' ? tx(lang, 'hJoinIncomplete', { n: parsed.missing }) : tx(lang, 'hJoinHint');

  const onChange = (raw: string) => {
    const p = parseJoinInput(raw);
    // A pasted link is replaced by the code it contains, so people see what will be joined.
    if (p.status === 'valid' && p.fromLink) {
      setValue(formatCode(p.code));
      setFromLink(true);
    } else {
      setValue(raw);
      setFromLink(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (parsed.status !== 'valid' || busy) return;
    setBusy(true);
    try {
      await onJoin(parsed.code, pass || undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="hm-card hm-join" aria-labelledby="hm-join-h">
      <h2 className="hm-card__title" id="hm-join-h">
        {tx(lang, 'hJoinTitle')}
      </h2>
      <p className="hm-card__lead">{tx(lang, 'hJoinLead')}</p>
      <form className="hm-join__form" data-testid="join-form" noValidate onSubmit={(e) => void submit(e)}>
        <TextField
          label={tx(lang, 'hJoinLabel')}
          code
          required
          inputMode="numeric"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={tx(lang, 'hJoinPlaceholder')}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
          hint={hint}
          error={errorText}
        />
        <TextField
          ref={passRef}
          label={tx(lang, 'passcodeRequired')}
          optionalText={tx(lang, 'uiOptional')}
          type="password"
          autoComplete="off"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          hint={passNote ? tx(lang, 'hPasscodeNeeded') : tx(lang, 'hPasscodeHint')}
        />
        <div className="hm-join__foot">
          <div className="hm-join__live" aria-live="polite">
            {okText ? (
              <span className="hm-join__ok">
                <IconCheckCircle size={16} />
                {okText}
              </span>
            ) : errorText ? (
              <span className="dx-sr-only">{errorText}</span>
            ) : null}
          </div>
          <Button type="submit" variant="primary" size="lg" loading={busy}>
            {tx(lang, 'join')}
          </Button>
        </div>
        {busy ? (
          <span className="dx-sr-only" role="status">
            {tx(lang, 'hJoining')}
          </span>
        ) : null}
      </form>
    </section>
  );
});
