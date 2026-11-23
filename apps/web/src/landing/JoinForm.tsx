import { useState, type FormEvent } from 'react';
import type { Key, Lang } from '../i18n';
import { tx } from '../home/text';
import { formatCode, parseJoinInput, type JoinParse } from '../home/logic';
import { Button, TextField } from '../ui';
import { appUrl } from '../routes';

function problem(p: JoinParse): Key | null {
  switch (p.status) {
    case 'valid':
      return null;
    case 'empty':
      return 'hJoinErrEmpty';
    case 'incomplete':
      return 'hJoinErrShort';
    case 'invalid':
      return p.reason === 'tooLong' ? 'hJoinErrTooLong' : p.reason === 'noCodeInLink' ? 'hJoinErrNoCode' : 'hJoinErrNotCode';
  }
}

export interface JoinFormProps {
  lang: Lang;
  /** Where the page goes with a valid code (injected so tests do not leave the page). */
  navigate: (url: string) => void;
  testId: string;
}

/** "Have a meeting code?": validates what was typed or pasted with the same parser the application uses. */
export function JoinForm({ lang, navigate, testId }: JoinFormProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<Key | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseJoinInput(value);
    const bad = problem(parsed);
    if (bad || parsed.status !== 'valid') {
      setError(bad ?? 'hJoinErrNotCode');
      return;
    }
    setError(null);
    navigate(appUrl(`?join=${parsed.code}`));
  };

  return (
    <form className="ln-join" data-testid={testId} onSubmit={submit} noValidate>
      <TextField
        label={tx(lang, 'lnJoinLabel')}
        hint={tx(lang, 'lnJoinHint')}
        placeholder={tx(lang, 'lnJoinPlaceholder')}
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        value={value}
        error={error ? tx(lang, error) : undefined}
        onChange={(e) => {
          const v = e.target.value;
          setValue(/^[\d\s.-]*$/.test(v) ? formatCode(v) : v);
          setError(null);
        }}
      />
      <Button type="submit" variant="secondary" size="lg">
        {tx(lang, 'lnJoinButton')}
      </Button>
    </form>
  );
}
