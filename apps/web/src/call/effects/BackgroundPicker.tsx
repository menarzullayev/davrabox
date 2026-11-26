import { t, type Lang } from '../../i18n';
import { Button, Dialog, IconBlur, IconImage, IconTrash, IconUpload, IconX } from '../../ui';
import { fmt } from '../announcer';
import { BUILT_IN_BACKGROUNDS, builtInThumb, type BgChoice } from './backgrounds';

export interface CustomThumb {
  id: string;
  url: string;
}

export interface BackgroundPickerProps {
  lang: Lang;
  open: boolean;
  onClose(): void;
  value: BgChoice;
  onChange(v: BgChoice): void;
  customs: CustomThumb[];
  /** Opens the device's file picker; the image is kept on this device only. */
  onUpload(): void;
  onRemoveCustom(id: string): void;
  /** The browser can segment video (virtual backgrounds and blur). */
  supported: boolean;
  camOn: boolean;
}

/** One choice: a toggle button (aria-pressed) with a thumbnail and a visible name. */
function Choice({ label, pressed, onClick, testId, thumb, icon, disabled }: { label: string; pressed: boolean; onClick(): void; testId: string; thumb?: string; icon?: React.ReactNode; disabled?: boolean }) {
  return (
    <Button variant="secondary" className="dv-bg__opt" aria-pressed={pressed} data-active={pressed ? '' : undefined} onClick={onClick} data-testid={testId} disabled={disabled}>
      <span className="dv-bg__thumb" aria-hidden="true" style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>
        {icon}
      </span>
      <span className="dv-bg__name">{label}</span>
    </Button>
  );
}

/** The virtual background chooser: none, blur, the built-in images and the person's own images (device only). */
export function BackgroundPicker(p: BackgroundPickerProps) {
  const { lang } = p;
  const off = !p.supported || !p.camOn;
  return (
    <Dialog open={p.open} onClose={p.onClose} title={t(lang, 'fxBackgroundTitle')} closeLabel={t(lang, 'uiClose')}>
      <div className="dv-bg" data-testid="bg-picker">
        {!p.supported ? <p className="dv-pop__note" data-testid="bg-unsupported">{t(lang, 'fxUnsupported')}</p> : null}
        {p.supported && !p.camOn ? <p className="dv-pop__note">{t(lang, 'fxCamOff')}</p> : null}
        <div className="dv-bg__grid" role="group" aria-label={t(lang, 'fxBackgroundTitle')}>
          <Choice label={t(lang, 'fxNone')} pressed={p.value === 'none'} onClick={() => p.onChange('none')} testId="bg-option-none" icon={<IconX size={22} />} disabled={off} />
          <Choice label={t(lang, 'fxBlur')} pressed={p.value === 'blur'} onClick={() => p.onChange('blur')} testId="bg-option-blur" icon={<IconBlur size={22} />} disabled={off} />
          {BUILT_IN_BACKGROUNDS.map((id) => (
            <Choice
              key={id}
              label={t(lang, `fxBg_${id}` as const)}
              pressed={p.value === `img:${id}`}
              onClick={() => p.onChange(`img:${id}`)}
              testId={`bg-option-${id}`}
              thumb={builtInThumb(id)}
              disabled={off}
            />
          ))}
          {p.customs.map((c, i) => (
            <div className="dv-bg__custom" key={c.id}>
              <Choice
                label={fmt(t(lang, 'fxCustom'), { n: i + 1 })}
                pressed={p.value === `custom:${c.id}`}
                onClick={() => p.onChange(`custom:${c.id}`)}
                testId="bg-option-custom"
                thumb={c.url}
                icon={<IconImage size={18} />}
                disabled={off}
              />
              <Button
                variant="ghost"
                size="sm"
                className="dv-bg__remove"
                icon={<IconTrash size={16} />}
                aria-label={`${t(lang, 'fxRemove')}: ${fmt(t(lang, 'fxCustom'), { n: i + 1 })}`}
                data-testid="bg-custom-remove"
                onClick={() => p.onRemoveCustom(c.id)}
              />
            </div>
          ))}
        </div>
        <Button variant="secondary" icon={<IconUpload size={18} />} onClick={p.onUpload} data-testid="bg-upload" disabled={off}>
          {t(lang, 'fxUpload')}
        </Button>
        <p className="dv-pop__note">{t(lang, 'fxUploadNote')}</p>
      </div>
    </Dialog>
  );
}

/** A programmatic file picker (no form control is rendered): resolves with the chosen file, or null when cancelled. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const el = document.createElement('input');
    el.type = 'file';
    el.accept = 'image/jpeg,image/png,image/webp';
    el.addEventListener('change', () => resolve(el.files?.[0] ?? null), { once: true });
    el.addEventListener('cancel', () => resolve(null), { once: true });
    el.click();
  });
}
