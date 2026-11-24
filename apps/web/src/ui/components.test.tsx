// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Alert, Button, Dialog, IconButton, Menu, Switch, Tabs, TextField, Tooltip, IconMic } from '.';

afterEach(cleanup);

describe('Button', () => {
  it('blocks clicks and announces busy while loading, keeps its accessible name', () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save</Button>);
    const b = screen.getByRole('button', { name: 'Save' });
    expect(b.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
  it('fires onClick normally and respects disabled', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<Button disabled onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it('IconButton is named by its required label', () => {
    render(<IconButton label="Mute" icon={<IconMic />} tooltip={false} />);
    expect(screen.getByRole('button', { name: 'Mute' })).toBeTruthy();
  });
});

describe('TextField', () => {
  it('links label, hint and error to the input and flags it invalid', () => {
    render(<TextField label="Code" hint="11 digits" error="Too short" />);
    const input = screen.getByLabelText('Code');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const ids = (input.getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids).toHaveLength(2);
    expect(ids.map((id) => document.getElementById(id)?.textContent).join('|')).toContain('Too short');
  });
  it('is valid without an error', () => {
    render(<TextField label="Name" />);
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBeNull();
  });
});

describe('Switch', () => {
  it('has the switch role and toggles', () => {
    render(<Switch label="Blur" />);
    const s = screen.getByRole('switch', { name: 'Blur' }) as HTMLInputElement;
    expect(s.checked).toBe(false);
    fireEvent.click(s);
    expect(s.checked).toBe(true);
  });
});

describe('Tooltip', () => {
  it('opens on focus with aria-describedby and closes on Escape without moving focus', () => {
    render(<Tooltip content="Mute microphone"><button>Mic</button></Tooltip>);
    const btn = screen.getByRole('button', { name: 'Mic' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(btn);
    const tip = screen.getByRole('tooltip');
    expect(btn.getAttribute('aria-describedby')).toBe(tip.id);
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(btn.getAttribute('aria-describedby')).toBeNull();
  });
  it('shifts back inside the screen when the bubble would run off the right edge', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tooltip' ? ({ left: 300, right: innerWidth + 40, top: 0, bottom: 20, width: 0, height: 20, x: 300, y: 0, toJSON: () => ({}) } as DOMRect) : new DOMRect();
    });
    render(<Tooltip content="A long label near the edge"><button>Edge</button></Tooltip>);
    fireEvent.focus(screen.getByRole('button'));
    const tip = screen.getByRole('tooltip');
    expect(tip.style.transform).toBe("translateX(calc(-50% - 48px))"); // innerWidth + 40 - (innerWidth - 8)
    spy.mockRestore();
  });
  it('closes on blur', () => {
    render(<Tooltip content="Hi"><button>X</button></Tooltip>);
    const btn = screen.getByRole('button');
    fireEvent.focus(btn);
    fireEvent.blur(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('Menu keyboard handling', () => {
  const setup = () => {
    const picked: string[] = [];
    render(
      <Menu
        items={[
          { id: 'a', label: 'Alpha', onSelect: () => picked.push('a') },
          { id: 'b', label: 'Beta', disabled: true, onSelect: () => picked.push('b') },
          { id: 'c', label: 'Gamma', onSelect: () => picked.push('c') },
        ]}
        trigger={(p) => <button {...p}>Actions</button>}
      />,
    );
    return picked;
  };
  const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

  it('opens with ArrowDown, focuses the first item, skips disabled ones and wraps', async () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Actions' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const menu = await screen.findByRole('menu');
    await raf();
    const items = within(menu).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: 'End' });
    expect(document.activeElement).toBe(items[2]);
  });
  it('ArrowUp opens on the last item; Escape closes and returns focus to the trigger', async () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Actions' });
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    const menu = await screen.findByRole('menu');
    await raf();
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitem')[2]);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
  it('selecting an item runs it, closes the menu and restores focus; disabled items do nothing', async () => {
    const picked = setup();
    const trigger = screen.getByRole('button', { name: 'Actions' });
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Beta' }));
    expect(picked).toEqual([]);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Gamma' }));
    expect(picked).toEqual(['c']);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it('typeahead moves focus to the matching item', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = await screen.findByRole('menu');
    await raf();
    fireEvent.keyDown(document.activeElement!, { key: 'g' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Gamma' }));
  });
  it('closes on outside pointer down', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    await screen.findByRole('menu');
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'a', label: 'One', panel: <p>panel one</p> },
    { id: 'b', label: 'Two', panel: <p>panel two</p>, disabled: true },
    { id: 'c', label: 'Three', panel: <p>panel three</p> },
  ];
  it('arrow keys move between enabled tabs, Home/End jump, one tab stop', () => {
    const onChange = vi.fn();
    render(<Tabs label="Demo" tabs={tabs} onChange={onChange} />);
    const [one, , three] = [screen.getByRole('tab', { name: 'One' }), screen.getByRole('tab', { name: 'Two' }), screen.getByRole('tab', { name: 'Three' })];
    expect(one.getAttribute('aria-selected')).toBe('true');
    expect(one.tabIndex).toBe(0);
    expect(three.tabIndex).toBe(-1);
    fireEvent.keyDown(one, { key: 'ArrowRight' });
    expect(three.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(three);
    expect(screen.getByText('panel three')).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith('c');
    fireEvent.keyDown(three, { key: 'ArrowRight' });
    expect(one.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(one, { key: 'End' });
    expect(three.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(three, { key: 'Home' });
    expect(one.getAttribute('aria-selected')).toBe('true');
  });
  it('wires tabs to panels', () => {
    render(<Tabs label="Demo" tabs={tabs} />);
    const tab = screen.getByRole('tab', { name: 'One' });
    const panel = screen.getByRole('tabpanel');
    expect(tab.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
  });
});

describe('Alert', () => {
  it('uses role=alert for danger and warning, role=status for info and success', () => {
    const { rerender } = render(<Alert tone="danger" title="x" />);
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<Alert tone="warning" title="x" />);
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<Alert tone="info" title="x" />);
    expect(screen.getByRole('status')).toBeTruthy();
    rerender(<Alert tone="success" title="x" />);
    expect(screen.getByRole('status')).toBeTruthy();
  });
  it('dismiss button carries the given label and fires', () => {
    const onDismiss = vi.fn();
    render(<Alert title="x" onDismiss={onDismiss} dismissLabel="Dismiss message" />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe('Dialog', () => {
  it('renders content only while open, names itself by the title and closes through the close button', () => {
    const onClose = vi.fn();
    const { rerender } = render(<Dialog open={false} onClose={onClose} title="Leave?" closeLabel="Close">body</Dialog>);
    expect(screen.queryByText('body')).toBeNull();
    rerender(<Dialog open onClose={onClose} title="Leave?" closeLabel="Close">body</Dialog>);
    const dlg = document.querySelector('dialog')!;
    expect(dlg.hasAttribute('open')).toBe(true);
    expect(dlg.getAttribute('aria-labelledby')).toBe(screen.getByRole('heading', { name: 'Leave?', hidden: true }).id);
    fireEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('a click on the dialog element itself (the backdrop) closes it, a click inside does not', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="T" closeLabel="Close"><span>inside</span></Dialog>);
    fireEvent.click(screen.getByText('inside', { exact: true }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector('dialog')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
