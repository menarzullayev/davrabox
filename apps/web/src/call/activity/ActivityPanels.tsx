import { useState, type FormEvent } from 'react';
import { t, type Lang } from '../../i18n';
import { Badge, Button, Checkbox, IconArrowUp, IconCheck, IconDownload, IconEye, IconEyeOff, IconPlus, IconTrash, IconX, Segmented, Switch, TextField } from '../../ui';
import { fmt } from '../announcer';
import { Drawer } from '../Panels';
import { MAX_OPTIONS, POLL_OPT_MAX, POLL_Q_MAX, QA_TEXT_MAX, newId, type Poll, type PollDef, type QaOp, type Question } from './protocol';

// ---- polls -------------------------------------------------------------------------------------------------------------
export interface PollsPanelProps {
  lang: Lang;
  polls: Poll[];
  manager: boolean;
  /** Someone who can count the votes is in the room. */
  managersPresent: boolean;
  onCreate(def: PollDef): void;
  onEnd(id: string): void;
  onVote(id: string, choices: number[]): void;
  onCsv(): void;
  onClose(): void;
}

function PollResults({ lang, p }: { lang: Lang; p: Poll }) {
  const total = Math.max(1, p.counts.reduce((a, b) => a + b, 0));
  return (
    <ul className="dv-poll__opts" data-testid="poll-results">
      {p.options.map((o, i) => {
        const n = p.counts[i] ?? 0;
        const pct = Math.round((n / total) * 100);
        const mine = p.mine?.includes(i);
        return (
          <li key={i} className="dv-poll__opt" data-testid="poll-result">
            <span className="dv-poll__line">
              <span>
                {o}
                {mine ? <span className="dx-sr-only"> ({t(lang, 'pollVoted')})</span> : null}
                {mine ? <IconCheck size={14} aria-hidden="true" /> : null}
              </span>
              <strong data-testid="poll-count">
                {n} · {pct}%
              </strong>
            </span>
            <span className="dv-poll__bar" aria-hidden="true">
              <span className="dv-poll__fill" style={{ width: `${pct}%` }} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function PollBallot({ lang, p, onVote, disabled }: { lang: Lang; p: Poll; onVote(choices: number[]): void; disabled: boolean }) {
  const [pick, setPick] = useState<number[]>([]);
  const toggle = (i: number) => setPick((cur) => (p.multi ? (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]) : [i]));
  return (
    <form
      className="dv-poll__form"
      onSubmit={(e) => {
        e.preventDefault();
        if (pick.length) onVote(pick);
      }}
    >
      {p.multi ? (
        <div className="dv-poll__opts" role="group" aria-label={p.q}>
          {p.options.map((o, i) => (
            <Checkbox key={i} label={o} checked={pick.includes(i)} onChange={() => toggle(i)} data-testid="poll-choice" />
          ))}
        </div>
      ) : (
        <div className="dv-poll__opts" role="radiogroup" aria-label={p.q}>
          {p.options.map((o, i) => (
            <Button key={i} variant="secondary" role="radio" aria-checked={pick.includes(i)} data-active={pick.includes(i) ? '' : undefined} onClick={() => toggle(i)} data-testid="poll-choice" fullWidth>
              {o}
            </Button>
          ))}
        </div>
      )}
      <Button type="submit" variant="primary" disabled={!pick.length || disabled} data-testid="poll-vote">
        {t(lang, 'pollVote')}
      </Button>
    </form>
  );
}

function PollForm({ lang, onCreate }: { lang: Lang; onCreate(def: PollDef): void }) {
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const [anon, setAnon] = useState(false);
  const [err, setErr] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const options = opts.map((o) => o.trim()).filter(Boolean);
    if (!q.trim() || options.length < 2) {
      setErr(true);
      return;
    }
    onCreate({ id: newId(), q: q.trim(), options, multi, anon });
    setQ('');
    setOpts(['', '']);
    setMulti(false);
    setAnon(false);
    setErr(false);
  };
  return (
    <form className="dv-poll__form" onSubmit={submit} data-testid="poll-form">
      <TextField label={t(lang, 'pollQuestion')} value={q} maxLength={POLL_Q_MAX} onChange={(e) => setQ(e.target.value)} data-testid="poll-question" error={err && !q.trim() ? t(lang, 'pollInvalid') : undefined} />
      {opts.map((o, i) => (
        <div className="dv-poll__optrow" key={i}>
          <TextField
            label={fmt(t(lang, 'pollOption'), { n: i + 1 })}
            value={o}
            maxLength={POLL_OPT_MAX}
            onChange={(e) => setOpts((cur) => cur.map((x, k) => (k === i ? e.target.value : x)))}
            data-testid="poll-option"
          />
          {opts.length > 2 ? (
            <Button variant="ghost" size="sm" icon={<IconX size={16} />} aria-label={`${t(lang, 'pollRemoveOption')} ${i + 1}`} onClick={() => setOpts((cur) => cur.filter((_, k) => k !== i))} />
          ) : null}
        </div>
      ))}
      {opts.length < MAX_OPTIONS ? (
        <Button variant="ghost" size="sm" icon={<IconPlus size={16} />} onClick={() => setOpts((cur) => [...cur, ''])} data-testid="poll-add-option">
          {t(lang, 'pollAddOption')}
        </Button>
      ) : null}
      <Checkbox label={t(lang, 'pollMulti')} checked={multi} onChange={(e) => setMulti(e.target.checked)} data-testid="poll-multi" />
      <Checkbox label={t(lang, 'pollAnon')} checked={anon} onChange={(e) => setAnon(e.target.checked)} data-testid="poll-anon" />
      {err && q.trim() ? <p className="dv-act__note" role="alert">{t(lang, 'pollInvalid')}</p> : null}
      <Button type="submit" variant="primary" data-testid="poll-launch">
        {t(lang, 'pollLaunch')}
      </Button>
    </form>
  );
}

export function PollsPanel(p: PollsPanelProps) {
  const { lang } = p;
  const [creating, setCreating] = useState(false);
  const list = [...p.polls].reverse();
  return (
    <Drawer id="dv-polls" label={t(lang, 'pollTitle')} title={t(lang, 'pollTitle')} onClose={p.onClose} lang={lang} testId="polls-panel">
      <div className="dv-act">
        <div className="dv-act__body">
          {p.manager ? (
            creating ? (
              <PollForm
                lang={lang}
                onCreate={(d) => {
                  p.onCreate(d);
                  setCreating(false);
                }}
              />
            ) : (
              <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setCreating(true)} data-testid="poll-new">
                {t(lang, 'pollNew')}
              </Button>
            )
          ) : null}
          {list.length === 0 && !creating ? <p className="dv-empty">{t(lang, p.manager ? 'pollEmptyHost' : 'pollEmpty')}</p> : null}
          {list.map((poll) => {
            const showResults = p.manager || !!poll.mine || !poll.open;
            return (
              <section key={poll.id} className="dv-poll" data-testid="poll" data-open={poll.open ? '' : undefined} aria-label={poll.q}>
                <h3 className="dv-poll__q">{poll.q}</h3>
                <div className="dv-poll__meta">
                  <Badge tone={poll.open ? 'success' : 'neutral'}>{t(lang, poll.open ? 'pollLive' : 'pollClosed')}</Badge>
                  <span data-testid="poll-voters">{fmt(t(lang, 'pollVotes'), { n: poll.voters })}</span>
                  {poll.anon ? <span>{t(lang, 'pollAnon')}</span> : null}
                </div>
                {poll.open && !poll.mine ? <PollBallot lang={lang} p={poll} onVote={(c) => p.onVote(poll.id, c)} disabled={!p.managersPresent} /> : null}
                {poll.mine && poll.open ? <p className="dv-act__note" data-testid="poll-voted">{t(lang, 'pollVoted')}</p> : null}
                {showResults ? <PollResults lang={lang} p={poll} /> : null}
                {p.manager && poll.open ? (
                  <div className="dv-act__row">
                    <Button variant="secondary" size="sm" onClick={() => p.onEnd(poll.id)} data-testid="poll-end">
                      {t(lang, 'pollClose')}
                    </Button>
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
        <div className="dv-act__foot">
          <p className="dv-act__note">{t(lang, 'ephemeral')}</p>
          {p.manager && p.polls.length ? (
            <Button variant="secondary" icon={<IconDownload size={18} />} onClick={p.onCsv} data-testid="polls-csv">
              {t(lang, 'csvDownload')}
            </Button>
          ) : null}
        </div>
      </div>
    </Drawer>
  );
}

// ---- Q&A ---------------------------------------------------------------------------------------------------------------
export interface QaPanelProps {
  lang: Lang;
  questions: Question[];
  manager: boolean;
  anonAllowed: boolean;
  myId: string;
  sort: 'top' | 'new';
  onSort(s: 'top' | 'new'): void;
  onAsk(text: string, anon: boolean): void;
  onVote(id: string, up: boolean): void;
  onMod(id: string, op: QaOp): void;
  onAnonAllowed(on: boolean): void;
  onCsv(): void;
  onClose(): void;
}

export function QaPanel(p: QaPanelProps) {
  const { lang } = p;
  const [draft, setDraft] = useState('');
  const [anon, setAnon] = useState(false);
  const ask = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    p.onAsk(text, anon && p.anonAllowed);
    setDraft('');
  };
  return (
    <Drawer id="dv-qa" label={t(lang, 'qaTitle')} title={t(lang, 'qaTitle')} onClose={p.onClose} lang={lang} testId="qa-panel">
      <div className="dv-act">
        <div className="dv-act__body">
          <Segmented
            label={t(lang, 'qaTitle')}
            options={[
              { id: 'top', label: t(lang, 'qaSortTop') },
              { id: 'new', label: t(lang, 'qaSortNew') },
            ]}
            value={p.sort}
            onChange={p.onSort}
            variant="pill"
          />
          {p.manager ? <Switch label={t(lang, 'qaAnonAllow')} checked={p.anonAllowed} onChange={(e) => p.onAnonAllowed(e.target.checked)} data-testid="qa-anon-allow" /> : null}
          {p.questions.length === 0 ? <p className="dv-empty">{t(lang, 'qaEmpty')}</p> : null}
          <ul className="dv-qa__list" aria-label={t(lang, 'qaTitle')}>
            {p.questions.map((q) => {
              const voted = q.voters.includes(p.myId);
              return (
                <li key={q.id} className="dv-qa__item" data-testid="qa-item" data-answered={q.answered ? '' : undefined} data-hidden={q.hidden ? '' : undefined}>
                  <Button
                    variant="ghost"
                    className="dv-qa__vote"
                    aria-pressed={voted}
                    aria-label={`${t(lang, voted ? 'qaUpvoted' : 'qaUpvote')}: ${q.voters.length}`}
                    onClick={() => p.onVote(q.id, !voted)}
                    data-testid="qa-upvote"
                  >
                    <IconArrowUp size={18} />
                    <span className="dv-qa__n" data-testid="qa-votes">{q.voters.length}</span>
                  </Button>
                  <div>
                    <p className="dv-qa__text">{q.text}</p>
                    <div className="dv-qa__who">
                      <span data-testid="qa-author">{q.authorName ?? t(lang, 'qaAnonName')}</span>
                      {q.answered ? <Badge tone="success">{t(lang, 'qaAnswered')}</Badge> : null}
                      {q.hidden ? <Badge tone="neutral">{t(lang, 'qaHiddenTag')}</Badge> : null}
                    </div>
                    {p.manager ? (
                      <div className="dv-qa__tools">
                        <Button variant="ghost" size="sm" icon={<IconCheck size={16} />} onClick={() => p.onMod(q.id, q.answered ? 'reopen' : 'answered')} data-testid="qa-answered" aria-pressed={q.answered}>
                          {t(lang, 'qaMarkAnswered')}
                        </Button>
                        <Button variant="ghost" size="sm" icon={q.hidden ? <IconEye size={16} /> : <IconEyeOff size={16} />} onClick={() => p.onMod(q.id, q.hidden ? 'unhide' : 'hide')} data-testid="qa-hide">
                          {t(lang, q.hidden ? 'qaUnhide' : 'qaHide')}
                        </Button>
                        <Button variant="ghost" size="sm" icon={<IconTrash size={16} />} onClick={() => p.onMod(q.id, 'delete')} data-testid="qa-delete">
                          {t(lang, 'qaDelete')}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="dv-act__foot">
          <form className="dv-poll__form" onSubmit={ask}>
            <TextField label={t(lang, 'qaPlaceholder')} value={draft} maxLength={QA_TEXT_MAX} onChange={(e) => setDraft(e.target.value)} data-testid="qa-input" autoComplete="off" />
            {p.anonAllowed ? <Checkbox label={t(lang, 'qaAnonymous')} checked={anon} onChange={(e) => setAnon(e.target.checked)} data-testid="qa-anon" /> : null}
            <Button type="submit" variant="primary" disabled={!draft.trim()} data-testid="qa-send">
              {t(lang, 'qaAsk')}
            </Button>
          </form>
          <p className="dv-act__note">{t(lang, 'ephemeral')}</p>
          {p.manager && p.questions.length ? (
            <Button variant="secondary" icon={<IconDownload size={18} />} onClick={p.onCsv} data-testid="qa-csv">
              {t(lang, 'csvDownload')}
            </Button>
          ) : null}
        </div>
      </div>
    </Drawer>
  );
}
