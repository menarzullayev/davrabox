import { Suspense, lazy, useState, type FormEvent } from 'react';
import type { Lang } from '../i18n';
import { t } from '../i18n';
import { Alert, Button, Dialog, IconChevronLeft, IconEdit, IconPlus, IconTrash, TextField } from '../ui';
import { tx } from '../home/text';
import { createBoard, deleteBoard, listBoards, renameBoard, type BoardMeta } from './boards-store';

const PersonalBoard = lazy(() => import('./PersonalBoard'));

function when(lang: Lang, ms: number): string {
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * "Whiteboards" (owner decision 1): personal boards that live on this device only (never on the server), with PNG/SVG export.
 * The board inside a meeting stays ephemeral and end-to-end encrypted in E2EE meetings; this is a separate, private place.
 */
export function WhiteboardsPage({ lang }: { lang: Lang }) {
  const [boards, setBoards] = useState<BoardMeta[]>(() => listBoards());
  const [open, setOpen] = useState<BoardMeta | null>(null);
  const [failed, setFailed] = useState(false);
  const [naming, setNaming] = useState<{ mode: 'new' | 'rename'; board?: BoardMeta } | null>(null);
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<BoardMeta | null>(null);
  const reload = () => setBoards(listBoards());

  const submitName = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim() || tx(lang, 'bdUntitled');
    try {
      if (naming?.mode === 'rename' && naming.board) {
        renameBoard(naming.board.id, n);
        reload();
      } else {
        const b = createBoard(n);
        reload();
        setOpen(b);
      }
      setFailed(false);
      setNaming(null);
    } catch {
      setFailed(true);
    }
  };

  if (open) {
    return (
      <main id="hm-main" className="home hm-main pb-main" tabIndex={-1} data-testid="whiteboards-page">
        <header className="pg-head pb-head">
          <Button variant="ghost" size="sm" icon={<IconChevronLeft size={18} />} data-testid="pb-back" onClick={() => {
            setOpen(null);
            reload();
          }}>
            {tx(lang, 'bdBack')}
          </Button>
          <h1 className="pg-title">{open.name}</h1>
        </header>
        <Suspense fallback={<p className="pg-empty">{tx(lang, 'bdLoading')}</p>}>
          <PersonalBoard lang={lang} id={open.id} name={open.name} />
        </Suspense>
      </main>
    );
  }

  return (
    <main id="hm-main" className="home hm-main" tabIndex={-1} data-testid="whiteboards-page">
      <header className="pg-head">
        <h1 className="pg-title">{tx(lang, 'bdTitle')}</h1>
        <p className="pg-lead">{tx(lang, 'bdLead')}</p>
        <div className="pg-actions">
          <Button variant="primary" icon={<IconPlus size={18} />} data-testid="bd-new" onClick={() => {
            setName('');
            setNaming({ mode: 'new' });
          }}>
            {tx(lang, 'bdNew')}
          </Button>
        </div>
      </header>
      {failed ? <Alert tone="danger">{tx(lang, 'bdSaveFailed')}</Alert> : null}
      {boards.length === 0 ? (
        <p className="pg-empty" data-testid="bd-empty">
          {tx(lang, 'bdEmpty')}
        </p>
      ) : (
        <ul className="pg-list">
          {boards.map((b) => (
            <li key={b.id} className="pg-item" data-testid="bd-item">
              <div className="pg-item__main">
                <p className="pg-item__title">{b.name}</p>
                <p className="pg-item__meta">{tx(lang, 'bdUpdated', { when: when(lang, b.updatedAt) })}</p>
              </div>
              <div className="pg-item__actions">
                <Button variant="secondary" size="sm" data-testid="bd-open" onClick={() => setOpen(b)}>
                  {tx(lang, 'bdOpen')}
                </Button>
                <Button variant="ghost" size="sm" icon={<IconEdit size={16} />} aria-label={`${tx(lang, 'bdRename')}: ${b.name}`} onClick={() => {
                  setName(b.name);
                  setNaming({ mode: 'rename', board: b });
                }} />
                <Button variant="ghost" size="sm" icon={<IconTrash size={16} />} aria-label={`${tx(lang, 'bdDelete')}: ${b.name}`} data-testid="bd-delete" onClick={() => setRemoving(b)} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={naming !== null}
        onClose={() => setNaming(null)}
        closeLabel={t(lang, 'uiClose')}
        title={tx(lang, naming?.mode === 'rename' ? 'bdRename' : 'bdNew')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setNaming(null)}>
              {t(lang, 'cancel')}
            </Button>
            <Button variant="primary" type="submit" form="bd-name-form" data-testid="bd-name-save">
              {t(lang, naming?.mode === 'rename' ? 'admSave' : 'create')}
            </Button>
          </>
        }
      >
        <form id="bd-name-form" className="hm-new__form" onSubmit={submitName}>
          <TextField label={tx(lang, 'bdName')} maxLength={80} value={name} placeholder={tx(lang, 'bdUntitled')} data-testid="bd-name" onChange={(e) => setName(e.target.value)} />
        </form>
      </Dialog>
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        closeLabel={t(lang, 'uiClose')}
        title={tx(lang, 'bdDelete')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              {t(lang, 'cancel')}
            </Button>
            <Button variant="danger" data-testid="bd-delete-confirm" onClick={() => {
              if (removing) deleteBoard(removing.id);
              setRemoving(null);
              reload();
            }}>
              {tx(lang, 'bdDelete')}
            </Button>
          </>
        }
      >
        <p className="hm-new__lead">{tx(lang, 'bdDeleteConfirm', { name: removing?.name ?? '' })}</p>
      </Dialog>
    </main>
  );
}
