// The whiteboard canvas: Excalidraw (MIT), loaded only when someone opens the board (a separate chunk).
import { useEffect, useMemo, useState } from 'react';
import { CaptureUpdateAction, Excalidraw, exportToBlob, exportToSvg, reconcileElements, restoreElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { t, type Lang } from '../../i18n';
import { Button, IconDownload, Switch } from '../../ui';
import { fileBase, saveBlob, stamp } from '../download';
import type { BoardApi } from './useBoard';

// Fonts come from our own origin (copied by scripts/prepare-assets.mjs); never from a CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/';

type ExApi = Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>['excalidrawAPI']>>[0];

function currentTheme(): 'light' | 'dark' {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'dark' || forced === 'light') return forced;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export interface WhiteboardProps {
  lang: Lang;
  board: BoardApi;
  /** Everyone except me, for the host's drawing permissions. */
  others: Array<{ id: string; name: string; manager: boolean }>;
  title: string;
  e2ee: boolean;
}

export default function Whiteboard({ lang, board, others, title, e2ee }: WhiteboardProps) {
  const [api, setApi] = useState<ExApi | null>(null);
  const initial = useMemo(() => ({ elements: restoreElements(board.elements() as never, null), scrollToContent: true }), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Remote changes are reconciled into the live scene without entering this person's undo history.
  useEffect(() => {
    if (!api) return undefined;
    return board.subscribe((changed) => {
      const remote = restoreElements(changed as never, null);
      const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), remote as never, api.getAppState());
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
    });
  }, [api, board]);

  const download = async (kind: 'png' | 'svg') => {
    if (!api) return;
    const elements = api.getSceneElements();
    const appState = { ...api.getAppState(), exportBackground: true };
    const name = `${fileBase(title, 'whiteboard')}-${stamp()}.${kind}`;
    if (kind === 'png') {
      saveBlob(await exportToBlob({ elements, appState, files: api.getFiles(), mimeType: 'image/png' }), name);
    } else {
      const svg = await exportToSvg({ elements, appState, files: api.getFiles() });
      saveBlob(new Blob([svg.outerHTML], { type: 'image/svg+xml' }), name);
    }
  };

  const members = others.filter((o) => !o.manager);
  return (
    <div className="dv-board" data-testid="board" data-can-draw={board.canDraw ? 'true' : 'false'}>
      <div className="dv-board__bar">
        <p className="dv-act__note" data-testid="board-mode">
          {t(lang, board.canDraw ? 'wbCanDraw' : 'wbViewOnly')}
          {e2ee ? ` · ${t(lang, 'wbEncrypted')}` : ''}
        </p>
        {board.manager ? (
          <>
            <Switch label={t(lang, 'wbAllowAll')} checked={board.perm.all} onChange={(e) => board.setPerm({ ...board.perm, all: e.target.checked })} data-testid="board-allow-all" />
            {!board.perm.all
              ? members.map((m) => {
                  const on = board.perm.ids.includes(m.id);
                  return (
                    <Button
                      key={m.id}
                      size="sm"
                      variant="secondary"
                      aria-pressed={on}
                      data-testid="board-allow"
                      onClick={() => board.setPerm({ ...board.perm, ids: on ? board.perm.ids.filter((x) => x !== m.id) : [...board.perm.ids, m.id] })}
                    >
                      {`${t(lang, on ? 'wbRevokeDraw' : 'wbAllowDraw')}: ${m.name}`}
                    </Button>
                  );
                })
              : null}
            <Button size="sm" variant="secondary" icon={<IconDownload size={16} />} onClick={() => void download('png')} data-testid="board-png" disabled={!api}>
              {t(lang, 'wbPng')}
            </Button>
            <Button size="sm" variant="secondary" icon={<IconDownload size={16} />} onClick={() => void download('svg')} data-testid="board-svg" disabled={!api}>
              {t(lang, 'wbSvg')}
            </Button>
          </>
        ) : null}
      </div>
      <div className="dv-board__canvas" data-testid="board-canvas">
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={initial as never}
          onChange={(els) => board.localChange(els as never)}
          viewModeEnabled={!board.canDraw}
          theme={currentTheme()}
          langCode={lang === 'ru' ? 'ru-RU' : 'en'}
          validateEmbeddable={false}
          UIOptions={{
            canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false, clearCanvas: board.manager, changeViewBackgroundColor: true },
            tools: { image: false },
          }}
          detectScroll
          handleKeyboardGlobally={false}
        />
      </div>
    </div>
  );
}
