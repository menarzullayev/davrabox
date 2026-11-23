import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { t, type Lang } from '../i18n';
import type { Reaction } from '../signals';
import { Alert, ConnectingRing } from '../ui';
// ui.css first: call.css overrides some .dx-btn values with equal specificity, so it must come later in the bundle.
import '../ui/ui.css';
import './call.css';
import { ControlBar } from './ControlBar';
import { LiveRegion, useCallAnnouncements } from './LiveRegion';
import { hintKey, pickFeatured, type FallbackReason, type LayoutMode } from './layout';
import { ChatPanel, PeoplePanel, RequestsTray, type ChatPanelProps } from './Panels';
import { RecordingLive } from './RecordingBadge';
import { Stage } from './Stage';
import { TopBar } from './TopBar';
import type { JoinRequestView, ManageActions, PanelId, ParticipantView, Quality, RecordingView, Role } from './types';

export interface CallViewProps {
  lang: Lang;
  title: string;
  /** False until the room is connected: the stage shows the connecting ring. */
  connected: boolean;
  reconnecting: boolean;
  quality: Quality;
  error: string | null;
  onDismissError(): void;

  /** Local participant first, then the others in join order (this order is what keeps the ring stable). */
  participants: ParticipantView[];
  /** Last person who spoke. */
  speakerId: string | null;
  /** Participant whose screen is shared, if any. */
  sharer: ParticipantView | null;
  renderMedia: (kind: 'camera' | 'share', p: ParticipantView) => ReactNode;

  role: Role;
  manage: ManageActions | null;
  locked: boolean;
  onLock?(): void;
  requests: JoinRequestView[];
  onDecide(id: string, admit: boolean): void;

  mic: boolean;
  cam: boolean;
  sharing: boolean;
  canShare: boolean;
  handUp: boolean;
  noiseOn: boolean | null;
  blurOn: boolean;
  relay: boolean;
  onMic(): void;
  onCam(): void;
  onShare(): void;
  onHand(): void;
  onReact(e: Reaction): void;
  onNoise(): void;
  onBlur(): void;
  onMoreOpen(): void;
  onLeave(): void;

  panel: PanelId;
  onPanel(id: PanelId): void;
  unread: number;
  chat: Omit<ChatPanelProps, 'lang' | 'onClose' | 'others'>;

  layout: LayoutMode;
  onLayout(m: LayoutMode): void;

  /** Recording consent state (every participant) and the host's controls. Absent in the lab and older tests. */
  recording?: RecordingView;
  /** End-to-end encrypted meeting: a persistent badge; `on` turns true once the encryption is confirmed active. */
  e2ee?: { on: boolean };
}

/** The whole call screen as a pure function of its props: no LiveKit, no network. Call.tsx and the lab feed it. */
export function CallView(p: CallViewProps) {
  const { lang } = p;
  const [resolved, setResolved] = useState<{ mode: LayoutMode; reason: FallbackReason; overflow: number }>({ mode: p.layout, reason: null, overflow: 0 });
  const [dismissed, setDismissed] = useState<FallbackReason>(null);
  const onResolved = useCallback((r: { mode: LayoutMode; reason: FallbackReason; overflow: number }) => {
    setResolved(r);
    if (r.reason === null) setDismissed(null);
  }, []);

  const ids = useMemo(() => p.participants.map((x) => x.id), [p.participants]);
  const featuredId = pickFeatured(ids, { sharerId: p.sharer?.id, speakerId: p.speakerId });
  const others = useMemo(() => p.participants.filter((x) => !x.local).map((x) => ({ id: x.id, name: x.name || x.id })), [p.participants]);
  const live = useCallAnnouncements({ lang, participants: p.participants, featuredId, sharer: p.sharer, waiting: p.requests.length, lastLine: p.chat.lines[p.chat.lines.length - 1] });

  const closePanel = useCallback(() => {
    const was = p.panel;
    p.onPanel(null);
    if (was) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid=${was}-toggle]`)?.focus());
  }, [p]);

  const showHint = resolved.reason !== null && dismissed !== resolved.reason && p.layout === 'davra';

  return (
    <div className="call dv-call" data-panel={p.panel ?? 'none'}>
      <TopBar lang={lang} title={p.title} count={p.participants.length} role={p.role} locked={p.locked} onLock={p.onLock} quality={p.reconnecting ? 'lost' : p.quality} recording={p.recording?.on} e2ee={p.e2ee} />
      <div className={`stage dv-main${p.panel ? ' with-chat' : ''}`}>
        <main className="dv-stagewrap" aria-label={t(lang, 'clStage')}>
          <Stage
            lang={lang}
            requested={p.layout}
            participants={p.participants}
            featuredId={featuredId}
            sharer={p.sharer}
            renderMedia={p.renderMedia}
            manage={p.manage}
            onResolved={onResolved}
          />
          {!p.connected ? (
            <div className="dv-connecting">
              <ConnectingRing label={t(lang, 'uiConnecting')} />
            </div>
          ) : null}
          <div className="dv-notices">
            {p.error ? (
              <Alert tone="danger" className="error dv-notice" onDismiss={p.onDismissError} dismissLabel={t(lang, 'uiDismiss')}>
                {p.error}
              </Alert>
            ) : null}
            {p.reconnecting ? <Alert tone="warning" className="dv-notice">{t(lang, 'clReconnecting')}</Alert> : null}
            {showHint ? (
              <Alert tone="info" className="dv-notice" onDismiss={() => setDismissed(resolved.reason)} dismissLabel={t(lang, 'uiDismiss')}>
                {t(lang, hintKey(resolved.reason))}
              </Alert>
            ) : null}
            {p.sharing ? <Alert tone="info" className="dv-notice">{t(lang, 'clYouShare')}</Alert> : null}
          </div>
          {p.manage && p.panel !== 'people' ? <RequestsTray lang={lang} requests={p.requests} onDecide={p.onDecide} /> : null}
        </main>
        {p.panel === 'chat' ? <ChatPanel lang={lang} {...p.chat} others={others} onClose={closePanel} /> : null}
        {p.panel === 'people' ? <PeoplePanel lang={lang} participants={p.participants} manage={p.manage} onClose={closePanel} /> : null}
      </div>
      <ControlBar
        lang={lang}
        mic={p.mic}
        cam={p.cam}
        sharing={p.sharing}
        canShare={p.canShare}
        handUp={p.handUp}
        panel={p.panel}
        unread={p.unread}
        waiting={p.manage ? p.requests.length : 0}
        layout={p.layout}
        fallback={resolved.reason}
        noiseOn={p.noiseOn}
        blurOn={p.blurOn}
        relay={p.relay}
        onMic={p.onMic}
        onCam={p.onCam}
        onShare={p.onShare}
        onHand={p.onHand}
        onReact={p.onReact}
        onPanel={p.onPanel}
        onLayout={p.onLayout}
        onNoise={p.onNoise}
        onBlur={p.onBlur}
        onMoreOpen={p.onMoreOpen}
        onLeave={p.onLeave}
        recording={p.recording}
      />
      <LiveRegion text={live} />
      <RecordingLive lang={lang} on={!!p.recording?.on} />
    </div>
  );
}

