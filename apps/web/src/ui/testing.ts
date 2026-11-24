// Test helpers for the custom Select (a listbox, not a native element). Not exported from the UI kit.
import { fireEvent, screen, within } from '@testing-library/react';

/** Opens the dropdown given by its trigger (or the trigger's label/test id) and chooses the option with this value. */
export function pickOption(trigger: HTMLElement | string, value: string): void {
  const el = typeof trigger === 'string' ? (screen.queryByTestId(trigger) ?? screen.getByLabelText(trigger)) : trigger;
  if (el.getAttribute('aria-expanded') !== 'true') fireEvent.click(el);
  const list = document.getElementById(el.getAttribute('aria-controls') ?? '') ?? screen.getByRole('listbox');
  const opt = [...list.querySelectorAll<HTMLElement>('[role=option]')].find((o) => o.dataset.value === value);
  if (!opt) throw new Error(`no option "${value}" in ${[...list.querySelectorAll<HTMLElement>('[role=option]')].map((o) => o.dataset.value).join(', ')}`);
  fireEvent.click(opt);
}

/** The option values the open (or openable) dropdown offers, in order. */
export function optionValues(trigger: HTMLElement): string[] {
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const list = within(document.body).getByRole('listbox');
  const values = [...list.querySelectorAll<HTMLElement>('[role=option]')].map((o) => o.dataset.value ?? '');
  fireEvent.click(trigger);
  return values;
}

/** Sets a DateTimePicker (by trigger) to `YYYY-MM-DDTHH:mm`: opens it, walks to the month, clicks the day, hour and minute, and closes it. */
export function setDateTime(trigger: HTMLElement | string, value: string): void {
  const el = typeof trigger === 'string' ? (screen.queryByTestId(trigger) ?? screen.getByLabelText(trigger)) : trigger;
  const [date, time] = value.split('T') as [string, string];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, min] = time.split(':').map(Number) as [number, number];
  if (el.getAttribute('aria-expanded') !== 'true') fireEvent.click(el);
  const want = `${y}-${String(m).padStart(2, '0')}`;
  for (let i = 0; i < 48 && document.querySelector('[data-ym]')?.getAttribute('data-ym') !== want; i++) {
    const cur = document.querySelector('[data-ym]')!.getAttribute('data-ym')!;
    fireEvent.click(screen.getByTestId(cur < want ? 'dt-next' : 'dt-prev'));
  }
  fireEvent.click(document.querySelector(`[data-day="${d}"]`)!);
  fireEvent.click(document.querySelector(`[data-hour="${h}"]`)!);
  fireEvent.click(document.querySelector(`[data-minute="${min}"]`)!);
  fireEvent.click(screen.getByTestId('dt-done'));
}
