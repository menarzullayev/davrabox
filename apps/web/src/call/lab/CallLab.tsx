import { useEffect, useMemo, useRef, useState } from 'react';
import type { Lang } from '../../i18n';
import { REACTIONS, type Reaction } from '../../signals';
import { applyTheme } from '../../ui';
import { CallView } from '../CallView';
import { RING_MAX, type LayoutMode } from '../layout';
import type { ChatLineView, ManageActions, PanelId, ParticipantView, Quality, Role } from '../types';
import { FakeVideo } from './FakeMedia';
import './lab.css';

/**
 * Development-only "call lab": the real call screen (CallView) fed with fake participants, so every state can be
 * inspected, screenshotted and measured without a LiveKit server. Everything is also settable through the URL:
 *   /lab/call?n=8&mode=davra&role=host&share=1&speaker=3&hands=2,4&react=1:🎉&panel=chat&requests=2
 *   &mute=2,3&camoff=4&cohost=1&long=1&sim=1&tick=1000&connecting=1&locked=1&quality=poor&error=1
 *   &lang=uz|ru|en&theme=dark|light&ui=0 (hide the lab panel)
 */
const NAMES = [
  'Nodir Aliyev', 'Aziz Karimov', 'Dilnoza Yusupova', 'Jasur Rahimov', 'Madina Qodirova', 'Bobur Tursunov', 'Nilufar Abdullayeva', 'Sardor Ismoilov',
  'Zilola Hamidova', 'Otabek Nazarov', 'Gulnora Saidova', 'Sherzod Mirzayev', 'Kamola Ergasheva', 'Davron Xolmatov', 'Feruza Normatova',
  'Rustam Aliyev', 'Lola Sobirova', 'Timur Qosimov', 'Hilola Rasulova', 'Akmal Botirov', 'Mohira Umarova', 'Eldor Yoqubov', 'Shahnoza Ortiqova',
  'Anvar Jalilov', 'Umida Karimova', 'Ilhom Safarov', 'Nodira Tojiyeva', 'Farhod Boboyev', 'Sevara Mamatova', 'Jamshid Qurbonov',
];
const LONG = 'Muhammadzohid Abdurahmonov-Qodirxo‘jayev';

function csv(v: string | null): number[] {
  return (v ?? '').split(',').map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x));
}

export default function CallLab() {
  const q = useMemo(() => new URLSearchParams(location.search), []);
  const [lang, setLang] = useState<Lang>((['uz', 'ru', 'en'] as const).find((l) => l === q.get('lang')) ?? 'uz');
  const [n, setN] = useState(Math.max(1, Math.min(30, parseInt(q.get('n') ?? '6', 10) || 6)));
  const [layout, setLayout] = useState<LayoutMode>((['davra', 'gallery', 'speaker'] as const).find((m) => m === q.get('mode')) ?? 'davra');
  const [role, setRole] = useState<Role>((['host', 'cohost', 'member'] as const).find((r) => r === q.get('role')) ?? 'host');
  const [share, setShare] = useState(q.get('share') === '1');
  const [speakerIdx, setSpeakerIdx] = useState(parseInt(q.get('speaker') ?? '1', 10) || 1);
  const [hands, setHands] = useState<number[]>(csv(q.get('hands')));
  const [muted, setMuted] = useState<number[]>(csv(q.get('mute')));
  const [camOff, setCamOff] = useState<number[]>(csv(q.get('camoff')));
  const [cohosts, setCohosts] = useState<number[]>(csv(q.get('cohost')));
  const [reactions, setReactions] = useState<Record<number, Reaction>>(() => {
    const m = /^(\d+):(.+)$/u.exec(q.get('react') ?? '');
    return m && (REACTIONS as readonly string[]).includes(m[2]!) ? { [Number(m[1])]: m[2] as Reaction } : {};
  });
  const [requests, setRequests] = useState(parseInt(q.get('requests') ?? '0', 10) || 0);
  const [panel, setPanel] = useState<PanelId>((['chat', 'people'] as const).find((p) => p === q.get('panel')) ?? null);
  const [connected, setConnected] = useState(q.get('connecting') !== '1');
  const [locked, setLocked] = useState(q.get('locked') === '1');
  const [recOn, setRecOn] = useState(q.get('rec') === '1');
  const [quality, setQuality] = useState<Quality>((['excellent', 'good', 'poor', 'lost', 'unknown'] as const).find((x) => x === q.get('quality')) ?? 'excellent');
  const [error, setError] = useState<string | null>(q.get('error') === '1' ? 'Xatolik yuz berdi' : null);
  const [mic, setMic] = useState(q.get('mic') !== '0');
  const [cam, setCam] = useState(q.get('cam') !== '0');
  const [myHand, setMyHand] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [noiseOn, setNoiseOn] = useState<boolean | null>(true);
  const [blurOn, setBlurOn] = useState(false);
  const [sim, setSim] = useState(q.get('sim') === '1');
  const [target, setTarget] = useState('');
  const [draft, setDraft] = useState('');
  const [lines, setLines] = useState<ChatLineView[]>(() =>
    q.get('chat') === '0'
      ? []
      : [
          { id: 1, from: 'Aziz Karimov', text: 'Assalomu alaykum! Boshlaymizmi?', mine: false, priv: false },
          { id: 2, from: 'Nodir Aliyev', text: 'Ha, hozir ekranni ulashaman.', mine: true, priv: false },
          { id: 3, from: 'Dilnoza Yusupova', text: 'Hisobot faylini yuboraman.', mine: false, priv: true },
          { id: 4, from: 'Dilnoza Yusupova', text: '', mine: false, priv: false, file: { id: '1', name: 'Q3-hisobot.xlsx', size: 183_000 } },
          { id: 5, from: 'Nodir Aliyev', text: 'Rahmat, ko‘rib chiqaman.', mine: true, priv: true, to: 'Dilnoza Yusupova' },
        ],
  );
  const lineId = useRef(10);
  const tick = Math.max(300, parseInt(q.get('tick') ?? '1000', 10) || 1000);

  useEffect(() => {
    const th = q.get('theme');
    if (th === 'light' || th === 'dark') applyTheme(th, false);
    document.documentElement.lang = lang;
  }, [q, lang]);

  // Fake speaking changes on a timer (the performance run uses tick=1000).
  useEffect(() => {
    if (!sim) return undefined;
    const id = setInterval(() => setSpeakerIdx((i) => 1 + (((i - 1 + 1 + Math.floor(Math.random() * 3)) % Math.max(1, n - 1)) || 0)), tick);
    return () => clearInterval(id);
  }, [sim, tick, n]);

  const speakerId = n > 1 ? `p${Math.min(speakerIdx, n - 1)}` : 'p0';
  const participants: ParticipantView[] = useMemo(
    () =>
      Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        name: q.get('long') === '1' && i === 2 ? LONG : (NAMES[i] ?? `Ishtirokchi ${i + 1}`),
        local: i === 0,
        speaking: `p${i}` === speakerId && !(i === 0),
        micMuted: i === 0 ? !mic : muted.includes(i),
        camOn: i === 0 ? cam : !camOff.includes(i),
        handUp: i === 0 ? myHand : hands.includes(i),
        reaction: reactions[i] ?? null,
        isCohost: cohosts.includes(i),
      })),
    [n, speakerId, mic, cam, muted, camOff, myHand, hands, reactions, cohosts, q],
  );
  const sharerIdx = share ? Math.min(Math.max(1, n > 1 ? 1 : 0), n - 1) : sharing ? 0 : -1;
  const sharer = sharerIdx >= 0 ? (participants[sharerIdx] ?? null) : null;

  const reqList = Array.from({ length: requests }, (_, i) => ({ id: `r${i}`, name: ['Nargiza Boboqulova', 'Ravshan Sultonov', 'Mehriniso Xudoyorova', 'Behzod Ne‘matov', 'Zarina Oripova'][i % 5]! }));
  const manage: ManageActions | null =
    role === 'member'
      ? null
      : {
          isHost: role === 'host',
          onMute: (id) => setMuted((m) => [...m, Number(id.slice(1))]),
          onRemove: () => setN((x) => Math.max(1, x - 1)),
          onToggleCohost: (id) => setCohosts((c) => (c.includes(Number(id.slice(1))) ? c.filter((x) => x !== Number(id.slice(1))) : [...c, Number(id.slice(1))])),
        };
  const react = (e: Reaction) => {
    setReactions((r) => ({ ...r, 0: e }));
    setTimeout(() => setReactions((r) => (r[0] === e ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== '0')) : r)), 3500);
  };

  return (
    <>
      <CallView
        lang={lang}
        title="Choraklik hisobot yig‘ilishi"
        connected={connected}
        reconnecting={q.get('reconnecting') === '1'}
        quality={quality}
        error={error}
        onDismissError={() => setError(null)}
        participants={participants}
        speakerId={speakerId}
        sharer={sharer}
        renderMedia={(kind, p) => (kind === 'share' || p.camOn ? <FakeVideo id={p.id} kind={kind} /> : null)}
        role={role}
        manage={manage}
        locked={locked}
        onLock={role === 'member' ? undefined : () => setLocked((l) => !l)}
        requests={reqList}
        onDecide={() => setRequests((r) => Math.max(0, r - 1))}
        mic={mic}
        cam={cam}
        sharing={sharing}
        canShare
        handUp={myHand}
        noiseOn={noiseOn}
        blurOn={blurOn}
        relay={q.get('relay') === '1'}
        onMic={() => setMic((m) => !m)}
        onCam={() => setCam((c) => !c)}
        onShare={() => setSharing((s) => !s)}
        onHand={() => setMyHand((h) => !h)}
        onReact={react}
        onNoise={() => setNoiseOn((x) => !(x ?? true))}
        onBlur={() => setBlurOn((b) => !b)}
        onMoreOpen={() => undefined}
        onLeave={() => setConnected(false)}
        panel={panel}
        onPanel={setPanel}
        unread={parseInt(q.get('unread') ?? '0', 10) || 0}
        chat={{
          lines,
          target,
          onTarget: setTarget,
          draft,
          onDraft: setDraft,
          onSend: (e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            setLines((l) => [...l, { id: ++lineId.current, from: 'Nodir Aliyev', text: draft.trim(), mine: true, priv: !!target, to: target ? participants.find((p) => p.id === target)?.name : undefined }]);
            setDraft('');
          },
          onAttach: () => undefined,
          onSave: () => undefined,
        }}
        layout={layout}
        onLayout={setLayout}
        recording={{
          on: recOn,
          e2ee: q.get('e2ee') === '1',
          busy: false,
          onToggle: role === 'member' ? undefined : () => setRecOn((r) => !r),
          items: [
            { id: 'r1', status: 'ready', startedAt: '2026-11-24T10:00:00Z', sizeBytes: 48_234_496 },
            { id: 'r2', status: 'stopping', startedAt: '2026-11-24T11:30:00Z', sizeBytes: null },
          ],
          onDownload: () => undefined,
        }}
      />
      {q.get('ui') === '0' ? null : (
        <details className="lab-panel" open={q.get('open') === '1'}>
          <summary>Call lab ({n})</summary>
          <div className="lab-grid">
            <label>
              People
              <input type="number" min={1} max={30} value={n} onChange={(e) => setN(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} />
              <span>ring up to {RING_MAX}</span>
            </label>
            <label>
              Language
              <select value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
                <option>uz</option>
                <option>ru</option>
                <option>en</option>
              </select>
            </label>
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option>host</option>
                <option>cohost</option>
                <option>member</option>
              </select>
            </label>
            <label>
              Speaker
              <input type="number" min={0} max={29} value={speakerIdx} onChange={(e) => setSpeakerIdx(Number(e.target.value))} />
            </label>
            <label><input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> remote screen share</label>
            <label><input type="checkbox" checked={sim} onChange={(e) => setSim(e.target.checked)} /> speaker changes every {tick} ms</label>
            <label><input type="checkbox" checked={!connected} onChange={(e) => setConnected(!e.target.checked)} /> connecting</label>
            <label>
              Quality
              <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)}>
                {(['excellent', 'good', 'poor', 'lost', 'unknown'] as const).map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
            <label>
              Requests
              <input type="number" min={0} max={9} value={requests} onChange={(e) => setRequests(Number(e.target.value))} />
            </label>
            <button type="button" onClick={() => setHands((h) => (h.includes(2) ? h.filter((x) => x !== 2) : [...h, 2]))}>toggle hand p2</button>
            <button type="button" onClick={() => setReactions((r) => ({ ...r, 3: '🎉' }))}>reaction p3</button>
            <button type="button" onClick={() => setMuted((m) => (m.includes(3) ? m.filter((x) => x !== 3) : [...m, 3]))}>toggle mute p3</button>
            <button type="button" onClick={() => setCamOff((m) => (m.includes(4) ? m.filter((x) => x !== 4) : [...m, 4]))}>toggle cam p4</button>
            <button type="button" onClick={() => setError('Xatolik yuz berdi')}>show error</button>
          </div>
        </details>
      )}
    </>
  );
}
