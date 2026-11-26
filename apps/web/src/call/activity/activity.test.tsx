// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canDraw, mergeInto, newer, ordered, parseBoard, sanitizeElement, type BoardElement } from '../board/protocol';
import { PollsPanel, QaPanel } from './ActivityPanels';
import { EMPTY_ACT, csvCell, leadManager, parseAct, pollsCsv, qaCsv, reduceAct, snapshot, visibleQuestions, type ActMsg, type ActState, type Sender } from './protocol';

afterEach(cleanup);

const host: Sender = { id: 'h', name: 'Host', role: 'host' };
const co: Sender = { id: 'c', name: 'Co', role: 'cohost' };
const ann: Sender = { id: 'a', name: 'Ann', role: 'member' };
const bob: Sender = { id: 'b', name: 'Bob', role: 'guest' };
const POLL = { id: 'poll-000001', q: 'Lunch?', options: ['Plov', 'Lagman'], multi: false, anon: false };
const run = (msgs: Array<[ActMsg, Sender]>, s: ActState = EMPTY_ACT) => msgs.reduce((st, [m, f], i) => reduceAct(st, m, f, 1000 + i), s);

describe('activity message validation', () => {
  it('accepts well-formed messages and normalises them', () => {
    expect(parseAct(JSON.stringify({ t: 'poll.open', poll: { ...POLL, q: '  Lunch?\n ' } }))).toEqual({ t: 'poll.open', poll: POLL });
    expect(parseAct(JSON.stringify({ t: 'poll.vote', id: 'poll-000001', choices: [1, 1, 0] }))).toEqual({ t: 'poll.vote', id: 'poll-000001', choices: [0, 1] });
    expect(parseAct(JSON.stringify({ t: 'qa.ask', id: 'q-0000001', text: 'line1\nline2', anon: false }))).toMatchObject({ text: 'line1\nline2' });
  });
  it('rejects malformed, oversized and unknown messages', () => {
    const bad = [
      'not json',
      '[]',
      JSON.stringify({ t: 'poll.open', poll: { ...POLL, options: ['only one'] } }),
      JSON.stringify({ t: 'poll.open', poll: { ...POLL, options: Array.from({ length: 11 }, (_, i) => `o${i}`) } }),
      JSON.stringify({ t: 'poll.open', poll: { ...POLL, q: 'x'.repeat(301) } }),
      JSON.stringify({ t: 'poll.open', poll: { ...POLL, id: '../../x' } }),
      JSON.stringify({ t: 'poll.vote', id: 'poll-000001', choices: [] }),
      JSON.stringify({ t: 'poll.vote', id: 'poll-000001', choices: [-1] }),
      JSON.stringify({ t: 'qa.ask', id: 'q-0000001', text: 'x'.repeat(501), anon: false }),
      JSON.stringify({ t: 'qa.ask', id: 'q-0000001', text: '\u0000\u0001', anon: false }),
      JSON.stringify({ t: 'qa.mod', id: 'q-0000001', op: 'promote' }),
      JSON.stringify({ t: 'eval', code: 'alert(1)' }),
      'x'.repeat(300 * 1024),
    ];
    for (const b of bad) expect(parseAct(b), b.slice(0, 60)).toBeNull();
  });
});

describe('polls', () => {
  it('only a host or co-host can open and end a poll', () => {
    expect(run([[{ t: 'poll.open', poll: POLL }, ann]]).polls).toHaveLength(0);
    expect(run([[{ t: 'poll.open', poll: POLL }, bob]]).polls).toHaveLength(0);
    const s = run([[{ t: 'poll.open', poll: POLL }, co]]);
    expect(s.polls[0]).toMatchObject({ open: true, by: 'c', counts: [0, 0] });
    expect(run([[{ t: 'poll.close', id: POLL.id }, ann]], s).polls[0]!.open).toBe(true);
    expect(run([[{ t: 'poll.close', id: POLL.id }, host]], s).polls[0]!.open).toBe(false);
  });
  it('counts one ballot per participant, refuses invalid choices and votes after the end', () => {
    let s = run([[{ t: 'poll.open', poll: POLL }, host]]);
    s = run([
      [{ t: 'poll.vote', id: POLL.id, choices: [1] }, ann],
      [{ t: 'poll.vote', id: POLL.id, choices: [0] }, ann], // second ballot ignored
      [{ t: 'poll.vote', id: POLL.id, choices: [0, 1] }, bob], // single-choice poll
      [{ t: 'poll.vote', id: POLL.id, choices: [5] }, bob], // no such option
      [{ t: 'poll.vote', id: POLL.id, choices: [0] }, bob],
    ], s);
    expect(s.polls[0]).toMatchObject({ counts: [1, 1], voters: 2 });
    s = run([[{ t: 'poll.close', id: POLL.id }, host], [{ t: 'poll.vote', id: POLL.id, choices: [0] }, co]], s);
    expect(s.polls[0]!.voters).toBe(2);
  });
  it('participants take the counts from a manager only; a manager with ballots keeps its own count', () => {
    const s = run([[{ t: 'poll.open', poll: POLL }, host]]);
    expect(run([[{ t: 'poll.tally', id: POLL.id, counts: [9, 9], voters: 18 }, ann]], s).polls[0]!.voters).toBe(0);
    expect(run([[{ t: 'poll.tally', id: POLL.id, counts: [3, 1], voters: 4 }, host]], s).polls[0]).toMatchObject({ counts: [3, 1], voters: 4 });
    const withBallots = run([[{ t: 'poll.vote', id: POLL.id, choices: [0] }, ann]], s);
    expect(run([[{ t: 'poll.tally', id: POLL.id, counts: [0, 1], voters: 1 }, co]], withBallots).polls[0]!.counts).toEqual([1, 0]);
  });
  it('the CSV has the counts, named ballots only for non-anonymous polls, and defuses formulas', () => {
    let s = run([[{ t: 'poll.open', poll: { ...POLL, q: '=HYPERLINK("x")' } }, host], [{ t: 'poll.open', poll: { ...POLL, id: 'poll-000002', anon: true } }, host]]);
    s = run([[{ t: 'poll.vote', id: POLL.id, choices: [0] }, ann], [{ t: 'poll.vote', id: 'poll-000002', choices: [1] }, ann]], s);
    const csv = pollsCsv(s.polls, (id) => (id === 'a' ? 'Ann' : id));
    expect(csv.startsWith('﻿poll,question')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    const named = csv.split('\r\n').filter((l) => l.includes('Ann'));
    expect(named).toHaveLength(1); // the anonymous poll's ballot is not named
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a,b')).toBe('"a,b"');
  });
});

describe('Q&A', () => {
  const ask = (id: string, anon = false): ActMsg => ({ t: 'qa.ask', id, text: `question ${id}`, anon });
  it('anonymous questions keep no identity, and only while the host allows them', () => {
    let s = run([[ask('q-0000001', true), ann]]);
    expect(s.qa[0]).toMatchObject({ author: 'a', authorName: 'Ann' }); // not allowed yet: shown with the name
    s = run([[{ t: 'qa.cfg', anon: true }, ann]], s);
    expect(s.anon).toBe(false); // members cannot change the setting
    s = run([[{ t: 'qa.cfg', anon: true }, host], [ask('q-0000002', true), bob]], s);
    expect(s.qa[1]).toMatchObject({ author: null, authorName: null });
    expect(JSON.stringify(s.qa[1])).not.toContain('"b"');
  });
  it('one upvote per participant; sorting by votes; hidden questions only for managers', () => {
    let s = run([[ask('q-0000001'), ann], [ask('q-0000002'), bob]]);
    s = run([
      [{ t: 'qa.vote', id: 'q-0000002', up: true }, ann],
      [{ t: 'qa.vote', id: 'q-0000002', up: true }, ann],
      [{ t: 'qa.vote', id: 'q-0000002', up: true }, co],
      [{ t: 'qa.vote', id: 'q-0000001', up: true }, bob],
      [{ t: 'qa.vote', id: 'q-0000001', up: false }, bob],
    ], s);
    expect(s.qa.map((q) => q.voters.length)).toEqual([0, 2]);
    expect(visibleQuestions(s.qa, false, 'top')[0]!.id).toBe('q-0000002');
    s = run([[{ t: 'qa.mod', id: 'q-0000002', op: 'hide' }, ann]], s);
    expect(s.qa[1]!.hidden).toBe(false);
    s = run([[{ t: 'qa.mod', id: 'q-0000002', op: 'hide' }, co], [{ t: 'qa.mod', id: 'q-0000001', op: 'answered' }, host]], s);
    expect(visibleQuestions(s.qa, false, 'top').map((q) => q.id)).toEqual(['q-0000001']);
    expect(visibleQuestions(s.qa, true, 'top')).toHaveLength(2);
    s = run([[{ t: 'qa.mod', id: 'q-0000001', op: 'delete' }, host]], s);
    expect(s.qa.map((q) => q.id)).toEqual(['q-0000002']);
    expect(qaCsv(s.qa, 'Anonymous')).toContain('question q-0000002,Bob,2,false,true');
  });
  it('a late joiner gets a snapshot from a manager only, without ballots', () => {
    let s = run([[{ t: 'poll.open', poll: POLL }, host], [{ t: 'poll.vote', id: POLL.id, choices: [1] }, ann], [ask('q-0000001'), ann]]);
    const snap = snapshot(s);
    expect(JSON.stringify(snap)).not.toContain('"votes"');
    const parsed = parseAct(JSON.stringify(snap))!;
    expect(run([[parsed, ann]]).polls).toHaveLength(0);
    s = run([[parsed, host]]);
    expect(s.polls[0]).toMatchObject({ counts: [0, 1], voters: 1, open: true });
    expect(s.qa).toHaveLength(1);
  });
  it('the lead manager is the present manager with the smallest identity', () => {
    expect(leadManager([{ id: 'z', role: 'host' }, { id: 'b', role: 'cohost' }, { id: 'a', role: 'member' }])).toBe('b');
    expect(leadManager([{ id: 'a', role: 'guest' }])).toBeNull();
  });
});

describe('whiteboard sync', () => {
  const el = (id: string, version: number, extra: Record<string, unknown> = {}): BoardElement => ({ id, type: 'rectangle', version, versionNonce: 5, x: 0, y: 0, width: 10, height: 10, ...extra });
  it('drops links, files, unknown types and malformed geometry', () => {
    expect(sanitizeElement(el('r1', 1, { link: 'javascript:alert(1)', customData: { x: 1 } }))).toMatchObject({ id: 'r1', link: null });
    expect(sanitizeElement(el('r1', 1, { customData: { x: 1 } }))).not.toHaveProperty('customData');
    expect(sanitizeElement({ ...el('i1', 1), type: 'image', fileId: 'f' })).toBeNull();
    expect(sanitizeElement({ ...el('e1', 1), type: 'embeddable' })).toBeNull();
    expect(sanitizeElement({ ...el('e1', 1), type: 'iframe' })).toBeNull();
    expect(sanitizeElement(el('r1', 1, { x: Number.NaN }))).toBeNull();
    expect(sanitizeElement(el('r1', 0))).toBeNull();
    expect(sanitizeElement(el('bad id!', 1))).toBeNull();
    expect(sanitizeElement({ ...el('f1', 1), type: 'freedraw', points: Array.from({ length: 4001 }, () => [0, 0]) })).toBeNull();
    expect(parseBoard(JSON.stringify({ t: 'els', els: [{ ...el('i1', 1), type: 'image' }] }))).toBeNull();
    expect(parseBoard(JSON.stringify({ t: 'perm', perm: { all: true, ids: [] } }))).toEqual({ t: 'perm', perm: { all: true, ids: [] } });
  });
  it('merges by version, ties by the lower nonce, and keeps z-order', () => {
    const store = new Map<string, BoardElement>();
    expect(mergeInto(store, [el('a', 2, { index: 'a1' }), el('b', 1, { index: 'a0' })])).toHaveLength(2);
    expect(mergeInto(store, [el('a', 1)])).toHaveLength(0);
    expect(newer({ ...el('a', 2), versionNonce: 1 }, store.get('a'))).toBe(true);
    expect(newer({ ...el('a', 2), versionNonce: 9 }, store.get('a'))).toBe(false);
    expect(ordered(store).map((e) => e.id)).toEqual(['b', 'a']);
    mergeInto(store, [el('b', 2, { isDeleted: true, index: 'a0' })]);
    expect(ordered(store).map((e) => e.id)).toEqual(['a']);
  });
  it('drawing needs the host’s permission', () => {
    expect(canDraw('a', false, { all: false, ids: [] })).toBe(false);
    expect(canDraw('a', false, { all: false, ids: ['a'] })).toBe(true);
    expect(canDraw('a', false, { all: true, ids: [] })).toBe(true);
    expect(canDraw('h', true, { all: false, ids: [] })).toBe(true);
  });
});

describe('panels', () => {
  const base = { lang: 'en' as const, onClose: () => {}, onCsv: () => {} };
  it('a member votes once and then sees the results; the host creates and ends polls', () => {
    const s = run([[{ t: 'poll.open', poll: POLL }, host]]);
    const onVote = vi.fn();
    const { unmount } = render(<PollsPanel {...base} polls={s.polls} manager={false} managersPresent onCreate={() => {}} onEnd={() => {}} onVote={onVote} />);
    expect(screen.queryByTestId('poll-new')).toBeNull();
    expect(screen.queryByTestId('poll-results')).toBeNull();
    fireEvent.click(screen.getAllByTestId('poll-choice')[1]!);
    fireEvent.click(screen.getByTestId('poll-vote'));
    expect(onVote).toHaveBeenCalledWith(POLL.id, [1]);
    unmount();
    const onCreate = vi.fn();
    const onEnd = vi.fn();
    render(<PollsPanel {...base} polls={s.polls} manager managersPresent onCreate={onCreate} onEnd={onEnd} onVote={() => {}} />);
    expect(screen.getByTestId('poll-results')).toBeTruthy();
    fireEvent.click(screen.getByTestId('poll-end'));
    expect(onEnd).toHaveBeenCalledWith(POLL.id);
    fireEvent.click(screen.getByTestId('poll-new'));
    fireEvent.click(screen.getByTestId('poll-launch'));
    expect(onCreate).not.toHaveBeenCalled(); // empty form
    fireEvent.change(screen.getByTestId('poll-question'), { target: { value: 'Coffee?' } });
    const opts = screen.getAllByTestId('poll-option');
    fireEvent.change(opts[0]!, { target: { value: 'Yes' } });
    fireEvent.change(opts[1]!, { target: { value: 'No' } });
    fireEvent.click(screen.getByTestId('poll-launch'));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ q: 'Coffee?', options: ['Yes', 'No'], multi: false, anon: false }));
    expect(screen.getByTestId('polls-csv')).toBeTruthy();
  });
  it('Q&A: the anonymous option appears only when allowed; moderation tools only for managers', () => {
    const s = run([[{ t: 'qa.ask', id: 'q-0000001', text: 'Why?', anon: false }, ann]]);
    const onAsk = vi.fn();
    const props = { ...base, questions: s.qa, myId: 'b', sort: 'top' as const, onSort: () => {}, onAsk, onVote: () => {}, onMod: () => {}, onAnonAllowed: () => {} };
    const { unmount } = render(<QaPanel {...props} manager={false} anonAllowed={false} />);
    expect(screen.queryByTestId('qa-anon')).toBeNull();
    expect(screen.queryByTestId('qa-hide')).toBeNull();
    fireEvent.change(screen.getByTestId('qa-input'), { target: { value: 'How?' } });
    fireEvent.click(screen.getByTestId('qa-send'));
    expect(onAsk).toHaveBeenCalledWith('How?', false);
    unmount();
    const onMod = vi.fn();
    render(<QaPanel {...props} onMod={onMod} manager anonAllowed />);
    expect(screen.getByTestId('qa-anon')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('qa-item')).getByTestId('qa-hide'));
    expect(onMod).toHaveBeenCalledWith('q-0000001', 'hide');
  });
});
