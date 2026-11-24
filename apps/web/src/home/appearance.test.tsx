// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AppearanceControls, ThemeToggle } from './AppearanceControls';
import { getPrefs, setPref } from '../prefs';
import { resetPrefsForTests } from '../prefs/store';

beforeEach(() => {
  localStorage.clear();
  resetPrefsForTests();
  setPref('lang', 'en', { persist: false });
  setPref('theme', 'dark', { persist: false });
});
afterEach(() => cleanup());

describe('appearance controls (one entry on every screen)', () => {
  it('the Dark/Light button switches with one press, both ways, and remembers it', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(getPrefs().theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(getPrefs().theme).toBe('dark');
  });

  it('the button name says what a press will do', () => {
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-toggle').getAttribute('aria-label')).toBe('Light');
  });

  it('without any props the panel changes the language and style through the preferences store', () => {
    render(<AppearanceControls />);
    expect(screen.getByTestId('theme-toggle')).toBeTruthy();
    fireEvent.click(screen.getByTestId('settings'));
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'ru' } });
    expect(getPrefs().lang).toBe('ru');
    fireEvent.change(screen.getByTestId('style-select'), { target: { value: 'swiss' } });
    expect(getPrefs().style).toBe('swiss');
  });

  it('explicit callbacks win over the store (screens that own the value)', () => {
    const calls: string[] = [];
    render(<ThemeToggle theme="dark" onTheme={(v) => calls.push(v)} />);
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(calls).toEqual(['light']);
    expect(getPrefs().theme).toBe('dark');
  });
});
