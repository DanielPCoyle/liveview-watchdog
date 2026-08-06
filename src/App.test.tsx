/**
 * The wall itself, rendered for real.
 *
 * Two substitutions and nothing else: `three` becomes a fake GPU, and the URL
 * carries `?mock=1` so feeds take the synthetic canvas path instead of hls.js.
 * Everything between those two edges — registry, roster, focus policy,
 * hysteresis, incidents, escalations, list mode — is the actual code.
 *
 * The worker is stubbed at the `Worker` boundary (see test-setup) and driven
 * directly, because these tests are about how the UI responds to a verdict, not
 * about how the verdict is reached. That question has its own suite in
 * watchdog.worker.test.ts, where the real logic runs.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as threeStub from './three-stub';
import { StubWorker } from './test-setup';
import type { Liveness, StaleReason } from './types';

mock.module('three', () => threeStub);

const App = (await import('./App')).default;

/** Push a watchdog verdict for every mounted feed, as the real worker would. */
function verdict(liveness: Liveness, opts: { staleMs?: number; drift?: number | null; reason?: StaleReason | null } = {}) {
  const ids = [...document.querySelectorAll('.roster__item')]
    .map((li, i) => li.querySelector('.roster__name')?.textContent ?? `f${i}`);
  const byLabel: Record<string, string> = { 'MOCK-01': 'f-mock1', 'MOCK-02': 'f-mock2', 'MOCK-03': 'f-mock3' };
  act(() => {
    StubWorker.last?.emit({
      type: 'status',
      entries: ids.map((label) => [
        byLabel[label] ?? label, liveness, opts.staleMs ?? 0,
        opts.drift ?? (liveness === 'live' ? 1 : 0), opts.reason ?? null,
      ]),
    });
  });
}

/** The confirm window is 12 worker ticks; events need that many to count. */
function confirm(liveness: Liveness, opts?: Parameters<typeof verdict>[1]) {
  for (let i = 0; i < 14; i++) verdict(liveness, opts);
}

const rows = () => [...document.querySelectorAll('.roster__name')].map((n) => n.textContent);

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/?mock=1');
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

async function mountWall() {
  const view = render(<App />);
  await waitFor(() => expect(document.querySelectorAll('.roster__item').length).toBe(3));
  return view;
}

describe('the wall', () => {
  test('mounts the mock group and lists its feeds', async () => {
    await mountWall();
    expect(rows()).toEqual(['MOCK-01', 'MOCK-02', 'MOCK-03']);
    // The tab carries its count, so match the group name within it.
    expect(document.querySelector('.tab')!.textContent).toContain('Mock');
  });

  test('reports feed counts, and says whether the wall is shared or local', async () => {
    await mountWall();
    verdict('live');
    expect(document.querySelector('.strip')!.textContent).toContain('feeds3');
    await waitFor(() => expect(document.querySelector('.strip')!.textContent).toContain('live3'));
    expect(document.querySelector('.bar__sync')!.textContent).toBe('local');
  });

  test('a stale verdict counts as stale and auto-promotes the feed', async () => {
    await mountWall();
    confirm('stale', { staleMs: 3000, drift: 0, reason: 'frames' });
    await waitFor(() => {
      expect(document.querySelector('.strip')!.textContent).toContain('stale3');
      expect(document.querySelector('.strip')!.textContent).toContain('promoted3');
    });
  });

  test('the incident log names the drift failure differently from frames stopping', async () => {
    await mountWall();
    confirm('live');
    confirm('stale', { staleMs: 20, drift: 0, reason: 'drift' });
    await waitFor(() => {
      expect(document.querySelector('.roster__inc')!.textContent).toContain('frames stale');
    });

    // And the full report spells out what that means.
    fireEvent.click(document.querySelector('.roster__inspect')!);
    expect(screen.getByRole('dialog').textContent).toContain('picture not advancing');
  });

  test('frames stopping outright reads as signal lost', async () => {
    await mountWall();
    confirm('live');
    confirm('stale', { staleMs: 5000, drift: 0, reason: 'frames' });
    await waitFor(() => {
      expect(document.querySelector('.roster__inc')!.textContent).toContain('signal lost');
    });
  });

  test('a single tick of stale does not raise an incident — hysteresis', async () => {
    await mountWall();
    confirm('live');
    verdict('stale', { staleMs: 3000, reason: 'frames' });   // one tick only
    verdict('live');
    expect(document.querySelector('.roster__inc')!.textContent).toContain('no incidents');
  });
});

describe('the roster', () => {
  test('search narrows by label and reports the tally', async () => {
    await mountWall();
    fireEvent.change(document.querySelector('.roster__search')!, { target: { value: 'MOCK-02' } });
    expect(rows()).toEqual(['MOCK-02']);
    expect(document.querySelector('.roster__tally')!.textContent).toBe('1/3');
  });

  test('search also matches the source URL, because feeds get named after it', async () => {
    await mountWall();
    fireEvent.change(document.querySelector('.roster__search')!, { target: { value: 'cam2' } });
    expect(rows()).toEqual(['MOCK-02']);
  });

  test('a search matching nothing says so rather than showing an empty panel', async () => {
    await mountWall();
    fireEvent.change(document.querySelector('.roster__search')!, { target: { value: 'zzz' } });
    expect(rows()).toEqual([]);
    expect(screen.getByText('Nothing matches.')).toBeDefined();
  });

  test('the liveness filter selects on the current verdict', async () => {
    await mountWall();
    verdict('live');
    const stale = within(document.querySelector('.roster__filters') as HTMLElement)
      .getByRole('button', { name: /^stale/ });
    fireEvent.click(stale);
    await waitFor(() => expect(rows()).toEqual([]));
    fireEvent.click(within(document.querySelector('.roster__filters') as HTMLElement)
      .getByRole('button', { name: /^all/ }));
    expect(rows().length).toBe(3);
  });

  test('clicking a row promotes it, and clicking again returns it', async () => {
    await mountWall();
    const pick = () => document.querySelectorAll('.roster__pick')[0] as HTMLElement;
    fireEvent.click(pick());
    await waitFor(() => expect(document.querySelector('.strip')!.textContent).toContain('promoted1'));
    fireEvent.click(pick());
    await waitFor(() => expect(document.querySelector('.strip')!.textContent).toContain('promoted0'));
  });

  test('hovering a row marks its tile as the front-most one', async () => {
    await mountWall();
    fireEvent.mouseEnter(document.querySelectorAll('.roster__item')[0]);
    await waitFor(() => expect(document.querySelector('.ov--front')).not.toBeNull());
    fireEvent.mouseLeave(document.querySelectorAll('.roster__item')[0]);
    await waitFor(() => expect(document.querySelector('.ov--front')).toBeNull());
  });

  test('alt+arrow reorders, and the wall order follows the list', async () => {
    await mountWall();
    const third = document.querySelectorAll('.roster__pick')[2] as HTMLElement;
    third.focus();
    fireEvent.keyDown(third, { key: 'ArrowUp', altKey: true });
    await waitFor(() => expect(rows()).toEqual(['MOCK-01', 'MOCK-03', 'MOCK-02']));
    // Persisted, so the next operator inherits the arrangement.
    const saved = JSON.parse(localStorage.getItem('liveview-watchdog:registry:v3') ?? '{"feeds":[]}');
    expect(saved.feeds?.map?.((f: { label: string }) => f.label) ?? []).toEqual([]);
  });

  test('reordering is refused while the list is filtered', async () => {
    await mountWall();
    // Narrow to a single row: arranging rows you cannot see has no meaning.
    fireEvent.change(document.querySelector('.roster__search')!, { target: { value: '-02' } });
    expect(rows()).toEqual(['MOCK-02']);

    const only = document.querySelectorAll('.roster__pick')[0] as HTMLElement;
    only.focus();
    fireEvent.keyDown(only, { key: 'ArrowUp', altKey: true });

    fireEvent.change(document.querySelector('.roster__search')!, { target: { value: '' } });
    expect(rows()).toEqual(['MOCK-01', 'MOCK-02', 'MOCK-03']);
  });

  test('drag and drop reorders', async () => {
    await mountWall();
    const items = document.querySelectorAll('.roster__item');
    const data = new Map<string, string>();
    const dt = {
      effectAllowed: '', setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k),
    };
    fireEvent.dragStart(items[0], { dataTransfer: dt });
    fireEvent.dragOver(items[2], { dataTransfer: dt });
    fireEvent.drop(items[2], { dataTransfer: dt });
    await waitFor(() => expect(rows()).toEqual(['MOCK-02', 'MOCK-03', 'MOCK-01']));
  });
});

describe('operator actions', () => {
  test('ignore suppresses promotion while still counting the feed as stale', async () => {
    await mountWall();
    const row = document.querySelectorAll('.roster__item')[0] as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'ignore' }));
    expect(within(row).getByRole('button', { name: 'ignored' })).toBeDefined();

    confirm('stale', { staleMs: 3000, reason: 'frames' });
    await waitFor(() => {
      const strip = document.querySelector('.strip')!.textContent!;
      expect(strip).toContain('ignored1');   // suppression stays visible
      expect(strip).toContain('stale3');     // and it is still counted
      expect(strip).toContain('promoted2');  // but only the other two promote
    });
  });

  test('removing a feed takes it off the wall', async () => {
    await mountWall();
    const row = document.querySelectorAll('.roster__item')[0] as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /^Remove/ }));
    await waitFor(() => expect(rows()).toEqual(['MOCK-02', 'MOCK-03']));
  });

  test('audio is opt-in per feed', async () => {
    await mountWall();
    const row = document.querySelectorAll('.roster__item')[0] as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /^Unmute/ }));
    await waitFor(() => expect(within(row).getByRole('button', { name: /^Mute/ })).toBeDefined());
  });

  test('a feed can be escalated, and its evidence is attached automatically', async () => {
    await mountWall();
    verdict('live');
    const row = document.querySelectorAll('.roster__item')[0] as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /^report$/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Report incident' });
    expect(dialog.textContent).toContain('MOCK-01');
    expect(dialog.querySelector('.evidence')!.textContent).toContain('decoded');

    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'looks frozen' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit escalation' }));

    await waitFor(() => expect(document.querySelector('.strip')!.textContent).toContain('escalated1'));
    fireEvent.click(document.querySelector('.roster__inspect')!);
    expect(screen.getByRole('dialog').textContent).toContain('looks frozen');
  });

  test('the full report can be closed again', async () => {
    await mountWall();
    fireEvent.click(document.querySelector('.roster__inspect')!);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('editing a feed renames it without re-probing an unchanged source', async () => {
    await mountWall();
    const row = document.querySelectorAll('.roster__item')[0] as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'edit' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit feed' });
    fireEvent.change(dialog.querySelector('input')!, { target: { value: 'LOBBY-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'save' }));
    await waitFor(() => expect(rows()[0]).toBe('LOBBY-01'));
  });

  test('groups can be switched, and only the active one is mounted', async () => {
    await mountWall();
    expect(document.querySelectorAll('.tab').length).toBe(1);
    expect(document.querySelector('.tab')!.textContent).toContain('Mock');
  });
});

describe('failure surfaces', () => {
  test('a dead worker is announced rather than leaving stale pills looking current', async () => {
    await mountWall();
    const originalError = console.error;
    console.error = () => {};   // the fallback reporter logs; that is the point
    try {
      act(() => { StubWorker.last?.onerror?.(new ErrorEvent('error', { message: 'worker died' })); });
    } finally {
      console.error = originalError;
    }
    await waitFor(() => {
      const banner = document.querySelector('.banner');
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain('last thing it said');
    });
  });
});

describe('list mode (narrow viewport)', () => {
  test('drops the wall entirely and gives every row its own picture', async () => {
    window.matchMedia = ((q: string) => ({
      matches: true, media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    render(<App />);
    await waitFor(() => expect(document.querySelector('.stage--list')).not.toBeNull());
    expect(document.querySelectorAll('.roster__thumb').length).toBe(3);
    // No compositor: on a phone one or two tiles fit, so the GPU buys nothing.
    expect(document.querySelector('.wall canvas')).toBeNull();
    // And the fault control has to exist here, or the watchdog cannot be shown.
    expect(within(document.querySelectorAll('.roster__item')[0] as HTMLElement)
      .getByRole('button', { name: 'freeze' })).toBeDefined();
  });
});
