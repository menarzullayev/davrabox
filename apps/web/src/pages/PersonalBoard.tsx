// A personal whiteboard (Excalidraw, MIT) loaded only when a board is opened (a separate chunk, like the in-meeting board).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Excalidraw, exportToBlob, exportToSvg, restoreElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { Lang } from '../i18n';
import { Button, IconDownload } from '../ui';
import { fileBase, saveBlob, stamp } from '../call/download';
import { tx } from '../home/text';
import { loadBoard, saveBoard } from './boards-store';

// Fonts come from our own origin (copied by scripts/prepare-assets.mjs); never from a CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/';

type ExApi = Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>['excalidrawAPI']>>[0];

function currentTheme(): 'light' | 'dark' {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced === 'dark' || forced === 'light') return forced;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export default function PersonalBoard({ lang, id, name }: { lang: Lang; id: string; name: string }) {
  const [api, setApi] = useState<ExApi | null>(null);
  const [state, setState] = useState<'saved' | 'failed' | null>(null);
  const timer = useRef<number | null>(null);
  const last = useRef<string>('');
  const initial = useMemo(() => ({ elements: restoreElements(loadBoard(id) as never, null), scrollToContent: true }), [id]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const onChange = (els: readonly unknown[]) => {
    const json = JSON.stringify(els);
    if (json === last.current) return; // pointer moves and selection changes do not touch the drawing
    last.current = json;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      try {
        saveBoard(id, JSON.parse(json) as unknown[]);
        setState('saved');
      } catch {
        setState('failed');
      }
    }, 800);
  };

  const download = async (kind: 'png' | 'svg') => {
    if (!api) return;
    const elements = api.getSceneElements();
    const appState = { ...api.getAppState(), exportBackground: true };
    const file = `${fileBase(name, 'whiteboard')}-${stamp()}.${kind}`;
    if (kind === 'png') saveBlob(await exportToBlob({ elements, appState, files: api.getFiles(), mimeType: 'image/png' }), file);
    else saveBlob(new Blob([(await exportToSvg({ elements, appState, files: api.getFiles() })).outerHTML], { type: 'image/svg+xml' }), file);
  };

  return (
    <div className="dv-board pb-board" data-testid="personal-board">
      <div className="dv-board__bar">
        <p className="dv-act__note" role="status" data-testid="pb-state">
          {state === 'failed' ? tx(lang, 'bdSaveFailed') : state === 'saved' ? tx(lang, 'bdSaved') : ''}
        </p>
        <Button size="sm" variant="secondary" icon={<IconDownload size={16} />} onClick={() => void download('png')} disabled={!api} data-testid="pb-png">
          {tx(lang, 'bdExportPng')}
        </Button>
        <Button size="sm" variant="secondary" icon={<IconDownload size={16} />} onClick={() => void download('svg')} disabled={!api} data-testid="pb-svg">
          {tx(lang, 'bdExportSvg')}
        </Button>
      </div>
      <div className="dv-board__canvas pb-canvas" data-testid="pb-canvas">
        <Excalidraw
          excalidrawAPI={setApi}
          initialData={initial as never}
          onChange={(els) => onChange(els)}
          theme={currentTheme()}
          langCode={lang === 'ru' ? 'ru-RU' : 'en'}
          validateEmbeddable={false}
          UIOptions={{
            canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false, clearCanvas: true, changeViewBackgroundColor: true },
            tools: { image: false },
          }}
          detectScroll
          handleKeyboardGlobally={false}
        />
      </div>
    </div>
  );
}
