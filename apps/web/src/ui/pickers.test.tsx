// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Combobox } from './Combobox';
import { DateTimePicker, formatDateTime, monthGrid, parseDateTime } from './DateTimePicker';
import { setDateTime } from './testing';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DateTimePicker helpers', () => {
  it('parses and formats the datetime-local text, and refuses impossible dates', () => {
    expect(parseDateTime('2026-12-01T09:05')).toEqual({ y: 2026, m: 12, d: 1, h: 9, min: 5 });
    expect(formatDateTime({ y: 2026, m: 3, d: 7, h: 0, min: 0 })).toBe('2026-03-07T00:00');
    for (const bad of ['', '2026-02-30T10:00', '2026-13-01T10:00', '2026-01-01T24:00', '2026-01-01 10:00', 'x']) expect(parseDateTime(bad)).toBeNull();
  });
  it('lays a month out Monday first', () => {
    const g = monthGrid(2026, 11); // 1 Nov 2026 is a Sunday: six blanks, then the days
    expect(g.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(g[6]).toBe(1);
    expect(g.filter((x) => x !== null)).toHaveLength(30);
    expect(g.length % 7).toBe(0);
  });
});

function Dt({ initial = '', required = false, narrow = false }: { initial?: string; required?: boolean; narrow?: boolean }) {
  if (narrow) vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
  const [v, setV] = useState(initial);
  return <DateTimePicker label="Start" lang="en" required={required} value={v} onChange={(e) => setV(e.target.value)} data-testid="dt" />;
}

describe('DateTimePicker', () => {
  it('shows the chosen value as text and keeps the raw value for forms', () => {
    render(<Dt initial="2026-12-01T09:00" />);
    const t = screen.getByTestId('dt');
    expect(t.getAttribute('data-value')).toBe('2026-12-01T09:00');
    expect(t.textContent).toMatch(/Dec 1, 2026/);
    expect(screen.getByRole('button', { name: /Start/ })).toBe(t);
  });

  it('chooses a day, hour and minute in another month', () => {
    render(<Dt initial="2026-11-24T10:30" />);
    setDateTime('dt', '2027-02-14T18:45');
    expect(screen.getByTestId('dt').getAttribute('data-value')).toBe('2027-02-14T18:45');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('starts at 09:00 when only a day is chosen on an empty value', () => {
    render(<Dt />);
    fireEvent.click(screen.getByTestId('dt'));
    fireEvent.click(document.querySelector('[data-day="10"]')!);
    expect(screen.getByTestId('dt').getAttribute('data-value')).toMatch(/-10T09:00$/);
  });

  it('moves the day with the arrow keys, over a month edge, and closes with Escape', () => {
    render(<Dt initial="2026-12-31T08:00" />);
    fireEvent.click(screen.getByTestId('dt'));
    const grid = screen.getByRole('grid');
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(document.querySelector('[data-ym]')!.getAttribute('data-ym')).toBe('2027-01');
    expect(document.activeElement?.getAttribute('data-day')).toBe('1');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('dt'));
  });

  it('clears an optional value, but a required one has no Clear', () => {
    const { unmount } = render(<Dt initial="2026-12-01T09:00" />);
    fireEvent.click(screen.getByTestId('dt'));
    fireEvent.click(screen.getByTestId('dt-clear'));
    expect(screen.getByTestId('dt').getAttribute('data-value')).toBe('');
    expect(screen.getByTestId('dt').textContent).toBe('Not set');
    unmount();
    render(<Dt initial="2026-12-01T09:00" required />);
    fireEvent.click(screen.getByTestId('dt'));
    expect(screen.queryByTestId('dt-clear')).toBeNull();
  });

  it('brings the chosen hour and minute into view when it opens', () => {
    const seen: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      seen.push(this.getAttribute('data-hour') ?? this.getAttribute('data-minute') ?? '');
    };
    render(<Dt initial="2026-12-01T14:35" />);
    fireEvent.click(screen.getByTestId('dt'));
    expect(seen).toEqual(['14', '35']);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('opens as a bottom sheet on a narrow screen', () => {
    render(<Dt initial="2026-12-01T09:00" narrow />);
    fireEvent.click(screen.getByTestId('dt'));
    expect(document.querySelector('.dx-sheet .dx-dtp')).toBeTruthy();
    fireEvent.click(screen.getByTestId('select-backdrop'));
    expect(document.querySelector('.dx-sheet')).toBeNull();
  });
});

function Cb({ onSubmit = () => undefined }: { onSubmit?: () => void }) {
  const [v, setV] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <Combobox label="Action" hint="Prefix" value={v} onChange={(e) => setV(e.target.value)} options={['auth.', 'user.', 'policy.']} />
    </form>
  );
}

describe('Combobox', () => {
  it('suggests on focus, filters while typing, and a click takes the suggestion', () => {
    render(<Cb />);
    const input = screen.getByRole('combobox', { name: 'Action' }) as HTMLInputElement;
    fireEvent.focus(input);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['auth.', 'user.', 'policy.']);
    fireEvent.change(input, { target: { value: 'pol' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['policy.']);
    fireEvent.click(screen.getByRole('option'));
    expect(input.value).toBe('policy.');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps free text and Enter on a suggestion does not submit the form', () => {
    const onSubmit = vi.fn();
    render(<Cb onSubmit={onSubmit} />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'anything.else' } });
    expect(input.value).toBe('anything.else');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('auth.');
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.submit(input.closest('form')!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the list and keeps the text', () => {
    render(<Cb />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'u' } });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.value).toBe('u');
  });
});
