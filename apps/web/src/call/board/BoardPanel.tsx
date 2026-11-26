import { Component, lazy, Suspense, type ReactNode } from 'react';
import { t, type Lang } from '../../i18n';
import { Drawer } from '../Panels';
import type { BoardApi } from './useBoard';

const Whiteboard = lazy(() => import('./Whiteboard'));

class ChunkBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface BoardPanelProps {
  lang: Lang;
  board: BoardApi;
  others: Array<{ id: string; name: string; manager: boolean }>;
  title: string;
  e2ee: boolean;
  onClose(): void;
}

/** The whiteboard drawer. Excalidraw is a large library: it is downloaded the first time someone opens the board. */
export function BoardPanel({ lang, board, others, title, e2ee, onClose }: BoardPanelProps) {
  const state = (key: 'wbLoading' | 'wbError') => (
    <div className="dv-board__state" data-testid={key === 'wbError' ? 'board-error' : 'board-loading'}>
      {t(lang, key)}
    </div>
  );
  return (
    <Drawer id="dv-board" label={t(lang, 'wbTitle')} title={t(lang, 'wbTitle')} onClose={onClose} lang={lang} testId="board-panel">
      <ChunkBoundary fallback={state('wbError')}>
        <Suspense fallback={state('wbLoading')}>
          <Whiteboard lang={lang} board={board} others={others} title={title} e2ee={e2ee} />
        </Suspense>
      </ChunkBoundary>
    </Drawer>
  );
}
