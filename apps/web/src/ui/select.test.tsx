// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Popover } from './Popover';
import { Select, readOptions, stepOption, typeAheadIndex } from './Select';
import { pickOption } from './testing';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const Demo = ({ onChange = () => undefined, narrow = false, ...p }: { onChange?: (v: string) => void; narrow?: boolean; defaultValue?: string; disabled?: boolean }) => {
  if (narrow) {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
  }
  return (
    <Select label="Role" hint="Who can do what" data-testid="role" onChange={(e) => onChange(e.target.value)} {...p}>
      <option value="member">Member</option>
      <option value="admin">Admin</option>
      <option value="owner" disabled>Owner</option>
      <option value="guest">Guest</option>
    </Select>
  );
};

describe('Select helpers', () => {
  it('reads options from children, fragments included, and uses the text when there is no value', () => {
    const opts = readOptions(<><option value="a">A</option><option>Plain</option></>);
    expect(opts.map((o) => [o.value, o.text])).toEqual([['a', 'A'], ['Plain', 'Plain']]);
  });
  it('steps over disabled options and stays at the ends', () => {
    const o = [{ disabled: false }, { disabled: true }, { disabled: false }];
    expect(stepOption(o, 0, 1)).toBe(2);
    expect(stepOption(o, 2, 1)).toBe(2);
    expect(stepOption(o, 2, -1)).toBe(0);
  });
  it('type-ahead wraps and skips disabled', () => {
    const o = [{ text: 'Alpha', disabled: false }, { text: 'Beta', disabled: true }, { text: 'Bravo', disabled: false }];
    expect(typeAheadIndex(o, 'b', 0)).toBe(2);
    expect(typeAheadIndex(o, 'a', 1)).toBe(0);
    expect(typeAheadIndex(o, 'z', 0)).toBe(-1);
  });
});

describe('Select (custom dropdown)', () => {
  it('is a labelled combobox that shows the chosen option and its hint', () => {
    render(<Demo defaultValue="admin" />);
    const trigger = screen.getByRole('combobox', { name: /Role/ });
    expect(trigger.textContent).toBe('Admin');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.getAttribute('aria-describedby')).toContain('-hint');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens on click, marks the chosen option, chooses with a click and closes', () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    const trigger = screen.getByTestId('role');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const opts = screen.getAllByRole('option');
    expect(opts.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    fireEvent.click(opts[1]!);
    expect(onChange).toHaveBeenCalledWith('admin');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.textContent).toBe('Admin');
    expect(document.activeElement).toBe(trigger);
  });

  it('works from the keyboard: arrows skip a disabled option, Enter chooses, Escape closes without choosing', () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    const trigger = screen.getByTestId('role');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: 'ArrowDown' }); // admin
    fireEvent.keyDown(list, { key: 'ArrowDown' }); // skips disabled owner -> guest
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('guest');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('typing a letter jumps to the matching option', () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    fireEvent.click(screen.getByTestId('role'));
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(list, { key: 'g' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('guest');
  });

  it('a disabled option cannot be chosen and a disabled select does not open', () => {
    const onChange = vi.fn();
    const { unmount } = render(<Demo onChange={onChange} />);
    fireEvent.click(screen.getByTestId('role'));
    fireEvent.click(screen.getByRole('option', { name: 'Owner' }));
    expect(onChange).not.toHaveBeenCalled();
    unmount();
    render(<Demo disabled />);
    fireEvent.click(screen.getByTestId('role'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('on a narrow screen the list is a bottom sheet; the backdrop closes it', () => {
    render(<Demo narrow />);
    fireEvent.click(screen.getByTestId('role'));
    expect(document.querySelector('.dx-sheet')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(4);
    fireEvent.click(screen.getByTestId('select-backdrop'));
    expect(document.querySelector('.dx-sheet')).toBeNull();
    fireEvent.click(screen.getByTestId('role'));
    fireEvent.click(screen.getByRole('option', { name: 'Guest' }));
    expect(screen.getByTestId('role').textContent).toBe('Guest');
  });

  it('the test helper chooses by value', () => {
    const onChange = vi.fn();
    render(<Demo onChange={onChange} />);
    pickOption('role', 'guest');
    expect(onChange).toHaveBeenCalledWith('guest');
  });

  it('Escape inside a dropdown closes only the dropdown, not the panel around it', () => {
    const Panel = () => {
      const anchor = { current: document.body } as { current: HTMLElement };
      return (
        <Popover open anchorRef={anchor} onClose={() => { document.body.dataset.panelClosed = '1'; }}>
          <Demo />
        </Popover>
      );
    };
    delete document.body.dataset.panelClosed;
    render(<Panel />);
    fireEvent.click(screen.getByTestId('role'));
    expect(screen.getByRole('listbox')).toBeTruthy();
    // fireEvent returns false when the default action was cancelled: a dialog around the panel must not close on this Escape.
    expect(fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.body.dataset.panelClosed).toBeUndefined();
    fireEvent.keyDown(screen.getByTestId('role'), { key: 'Escape' });
    expect(document.body.dataset.panelClosed).toBe('1');
  });

  it('choosing in the bottom sheet of a Select inside a Popover does not close that Popover first', () => {
    const closed = vi.fn();
    const onChange = vi.fn();
    const Panel = () => {
      const anchor = { current: document.createElement('button') } as { current: HTMLElement };
      return (
        <Popover open anchorRef={anchor} onClose={closed}>
          <Demo narrow onChange={onChange} />
        </Popover>
      );
    };
    render(<Panel />);
    fireEvent.click(screen.getByTestId('role'));
    const option = screen.getByRole('option', { name: 'Guest' });
    // A real tap sends pointerdown on the option (portaled outside the Popover's DOM) before the click.
    fireEvent.pointerDown(option);
    expect(closed).not.toHaveBeenCalled();
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('guest');
  });
});

describe('a dropdown inside another panel', () => {
  afterEach(cleanup);
  function Nested({ onPick }: { onPick: (v: string) => void }) {
    const anchor = { current: document.body.appendChild(document.createElement('button')) };
    return (
      <Popover open anchorRef={anchor} onClose={() => onPick('closed')}>
        <div style={{ backdropFilter: 'blur(0px)' }}>
          <Select label="Style" defaultValue="a" onChange={(e) => onPick(e.target.value)}>
            <option value="a">A</option>
            <option value="b">B</option>
          </Select>
        </div>
      </Popover>
    );
  }
  it('renders its list at the top of the page, not inside the parent panel, and choosing keeps the parent open', () => {
    const onPick = vi.fn();
    render(<Nested onPick={onPick} />);
    fireEvent.click(screen.getByRole('combobox'));
    const list = screen.getByRole('listbox');
    // A parent with a backdrop filter is the reference box of fixed children: the list must not live inside it.
    expect(list.closest('.dx-popover')?.parentElement).toBe(document.body);
    expect(list.closest('.dx-popover')?.contains(screen.getByRole('combobox'))).toBe(false);
    const option = screen.getByRole('option', { name: 'B' });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    expect(onPick).toHaveBeenCalledWith('b');
    expect(onPick).not.toHaveBeenCalledWith('closed');
  });
});
