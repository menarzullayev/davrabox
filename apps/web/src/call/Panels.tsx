import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';
import { t, type Lang } from '../i18n';
import { MAX_CHAT_LENGTH } from '../signals';
import { Avatar, Badge, Button, IconButton, IconHand, IconMicOff, IconPaperclip, IconSend, IconShield, IconUser, IconX, Select } from '../ui';
import { fmt } from './announcer';
import type { ChatLineView, JoinRequestView, ManageActions, ParticipantView } from './types';

function Drawer({ id, label, title, onClose, lang, testId, children }: { id: string; label: string; title: string; onClose(): void; lang: Lang; testId: string; children: ReactNode }) {
  const root = useRef<HTMLElement>(null);
  // Escape closes the drawer when focus is inside it (popovers and menus stop Escape themselves).
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <div className="dv-scrim" onClick={onClose} aria-hidden="true" />
      <aside ref={root} className="chat dv-drawer" id={id} aria-label={label} data-testid={testId}>
        <div className="dv-drawer__head">
          <h2>{title}</h2>
          <IconButton label={t(lang, 'uiClose')} icon={<IconX size={18} />} tooltip={false} onClick={onClose} />
        </div>
        {children}
      </aside>
    </>
  );
}

function kb(size: number) {
  return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
}

export interface ChatPanelProps {
  lang: Lang;
  lines: ChatLineView[];
  /** Everyone except yourself: the recipients of a private message. */
  others: Array<{ id: string; name: string }>;
  target: string;
  onTarget(id: string): void;
  draft: string;
  onDraft(v: string): void;
  onSend(e: FormEvent): void;
  onAttach(file: File | undefined): void;
  onSave(f: { id: string; name: string }): void;
  /** End-to-end encrypted meeting: files would pass through the server, so attaching is switched off and explained. */
  noFiles?: boolean;
  onClose(): void;
}

export function ChatPanel(p: ChatPanelProps) {
  const { lang } = p;
  const fileInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Opening the chat puts the cursor in the message box; new lines keep the list scrolled to the end.
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [p.lines.length]);
  return (
    <Drawer id="dv-chat" label={t(lang, 'chat')} title={t(lang, 'chat')} onClose={p.onClose} lang={lang} testId="chat-panel">
      {/* role=log without aria-live: new lines are announced by the debounced live region, not line by line. */}
      <div className="chat-lines dv-lines" data-testid="chat-lines" ref={list} role="log" aria-live="off" tabIndex={0} aria-label={t(lang, 'chat')}>
        {p.lines.length === 0 ? <p className="dv-empty">{t(lang, 'clChatEmpty')}</p> : null}
        {p.lines.map((l) => (
          <div className={`chat-line dv-line${l.mine ? ' mine' : ''}`} key={l.id} data-testid="chat-line">
            <Avatar name={l.from} size={28} decorative />
            <div className="dv-line__body">
              <div className="dv-line__meta">
                <strong>{l.from}</strong>
                {l.priv ? <Badge tone="gold" className="tag">{l.mine && l.to ? `${t(lang, 'privateTo')} ${l.to}` : t(lang, 'privateTag')}</Badge> : null}
              </div>
              {/* Plain text only: React escapes it, nothing is parsed as HTML or turned into a link. */}
              {l.file ? (
                <button type="button" className="file-chip dv-file" onClick={() => p.onSave(l.file!)} data-testid="file-chip">
                  <IconPaperclip size={16} />
                  <span className="dv-file__name">{l.file.name}</span>
                  <span className="muted">({kb(l.file.size)})</span>
                </button>
              ) : (
                <div className="chat-text">{l.text}</div>
              )}
            </div>
          </div>
        ))}
      </div>
      <form onSubmit={p.onSend} className="chat-form dv-form">
        <Select label={t(lang, 'clChatTo')} value={p.target} onChange={(e) => p.onTarget(e.target.value)} data-testid="chat-target">
          <option value="">{t(lang, 'toEveryone')}</option>
          {p.others.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </Select>
        {p.noFiles ? <p className="dv-empty" data-testid="e2ee-nofiles">{t(lang, 'e2eeNoFiles')}</p> : null}
        <div className="dv-form__row">
          {p.noFiles ? null : (
            <>
              <input ref={fileInput} type="file" hidden onChange={(e) => { p.onAttach(e.target.files?.[0]); e.target.value = ''; }} data-testid="file-input" />
              <IconButton label={t(lang, 'attach')} icon={<IconPaperclip size={18} />} variant="secondary" tooltip={false} onClick={() => fileInput.current?.click()} data-testid="attach" />
            </>
          )}
          <input
            ref={input}
            className="dx-input"
            value={p.draft}
            maxLength={MAX_CHAT_LENGTH}
            placeholder={t(lang, 'chatPlaceholder')}
            aria-label={t(lang, 'chatPlaceholder')}
            onChange={(e) => p.onDraft(e.target.value)}
            data-testid="chat-input"
            autoComplete="off"
          />
          <IconButton label={t(lang, 'send')} icon={<IconSend size={18} />} variant="primary" tooltip={false} type="submit" />
        </div>
      </form>
    </Drawer>
  );
}

export interface PeoplePanelProps {
  lang: Lang;
  participants: ParticipantView[];
  manage: ManageActions | null;
  onClose(): void;
}

/** Roster with state and, for managers, the same mute / remove / co-host actions as the tiles (keyboard friendly list). */
export function PeoplePanel({ lang, participants, manage, onClose }: PeoplePanelProps) {
  return (
    <Drawer id="dv-people" label={t(lang, 'clPeopleTitle')} title={`${t(lang, 'clPeopleTitle')} (${participants.length})`} onClose={onClose} lang={lang} testId="people-panel">
      <ul className="dv-roster" aria-label={t(lang, 'clParticipants')}>
        {participants.map((p) => (
          <li key={p.id} className="dv-person" data-testid="roster-person">
            <Avatar name={p.name || '?'} id={p.id} size={36} decorative />
            <div className="dv-person__name">
              <strong>{p.name || p.id}{p.local ? ` (${t(lang, 'you')})` : ''}</strong>
              <span className="dv-person__state">
                {p.isCohost ? <span><IconShield size={14} />{t(lang, 'cohostBadge')}</span> : null}
                {p.micMuted ? <span><IconMicOff size={14} />{t(lang, 'clWordMuted')}</span> : null}
                {p.handUp ? <span><IconHand size={14} />{t(lang, 'clWordHand')}</span> : null}
              </span>
            </div>
            {manage && !p.local ? (
              <span className="dv-person__actions">
                {manage.isHost ? (
                  <IconButton label={`${p.isCohost ? t(lang, 'dismissCohost') : t(lang, 'makeCohost')}: ${p.name}`} icon={<IconUser size={16} />} size="sm" variant="ghost" tooltip={false} onClick={() => manage.onToggleCohost(p.id)} data-testid="roster-cohost" />
                ) : null}
                <IconButton label={`${t(lang, 'muteAudio')}: ${p.name}`} icon={<IconMicOff size={16} />} size="sm" variant="ghost" tooltip={false} onClick={() => manage.onMute(p.id)} data-testid="roster-mute" />
                <IconButton label={`${t(lang, 'removeFromMeeting')}: ${p.name}`} icon={<IconX size={16} />} size="sm" variant="ghost" tooltip={false} onClick={() => manage.onRemove(p.id)} data-testid="roster-remove" />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Drawer>
  );
}

/** Waiting-room requests for managers: a card in the corner of the stage that stays until each person is answered. */
export function RequestsTray({ lang, requests, onDecide }: { lang: Lang; requests: JoinRequestView[]; onDecide(id: string, admit: boolean): void }) {
  if (requests.length === 0) return null;
  return (
    <section className="requests dv-requests" aria-label={t(lang, 'requests')}>
      <h2>{t(lang, 'requests')} <span className="dv-requests__n">{fmt('{n}', { n: requests.length })}</span></h2>
      {requests.slice(0, 4).map((r) => (
        <div className="request dv-request" key={r.id} data-testid="join-request">
          <Avatar name={r.name} id={r.id} size={32} decorative />
          <span className="dv-request__name">{r.name}</span>
          <Button className="primary" variant="primary" size="sm" onClick={() => onDecide(r.id, true)}>{t(lang, 'admit')}</Button>
          <Button variant="secondary" size="sm" onClick={() => onDecide(r.id, false)}>{t(lang, 'deny')}</Button>
        </div>
      ))}
      {requests.length > 4 ? <p className="dv-requests__more">+{requests.length - 4}</p> : null}
    </section>
  );
}
