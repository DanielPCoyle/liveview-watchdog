/**
 * The feed dialog, and specifically the probe.
 *
 * This screen is the gate a bad source has to get through, and the verdicts it
 * shows encode a survey of real public streams: VOD posing as live, masters
 * advertising variants that 404, playlists that are CORS-clean while their
 * segments are not. The rule worth pinning is which of those still lets you
 * proceed and which does not.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FeedDialog from './FeedDialog';

const realFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = realFetch; });

const LIVE = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg1.ts\n#EXTINF:10.0,\nseg2.ts\n';

function serveLive() {
  globalThis.fetch = (async (input: RequestInfo | URL) => ({
    ok: true, status: String(input).includes('seg') ? 206 : 200,
    text: async () => (String(input).includes('seg') ? '' : LIVE),
  })) as unknown as typeof fetch;
}
function serveVod() {
  globalThis.fetch = (async () => ({
    ok: true, status: 200, text: async () => `${LIVE}#EXT-X-ENDLIST\n`,
  })) as unknown as typeof fetch;
}

const EXISTING = { label: 'LOBBY-01', src: 'https://cam.test/live.m3u8' };

describe('editing an existing feed', () => {
  test('opens on the feed being edited', () => {
    render(<FeedDialog groupName="Street" initial={EXISTING} onSave={() => {}} onCancel={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Edit feed' })).toBeDefined();
    expect(screen.getByText(/LOBBY-01/)).toBeDefined();
  });

  /** A rename should not have to re-probe a source that was vetted already. */
  test('saves an unchanged source without requiring a probe', () => {
    const saved: string[] = [];
    render(<FeedDialog groupName="Street" initial={EXISTING}
      onSave={(label) => saved.push(label)} onCancel={() => {}} />);
    const save = screen.getByRole('button', { name: 'save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.change(screen.getByPlaceholderText('e.g. LOBBY-01'), { target: { value: 'LOBBY-02' } });
    fireEvent.click(save);
    expect(saved).toEqual(['LOBBY-02']);
  });

  test('a live source is reported as acceptable', async () => {
    serveLive();
    render(<FeedDialog groupName="Street" initial={EXISTING} onSave={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'check' }));
    await waitFor(() => expect(document.querySelector('.probe--ok')).not.toBeNull());
    expect(document.querySelector('.probe')!.textContent).toContain('live');
  });

  /**
   * VOD is the trap: it fetches fine and plays fine, and it can never go stale,
   * so the watchdog would have nothing to watch.
   */
  test('a VOD source is rejected, but can still be forced through', async () => {
    serveVod();
    const saved: string[] = [];
    render(<FeedDialog groupName="Street" initial={EXISTING}
      onSave={(l) => saved.push(l)} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'check' }));

    await waitFor(() => expect(document.querySelector('.probe--bad')).not.toBeNull());
    expect(document.querySelector('.probe')!.textContent).toContain('vod');

    // Rejected, not forbidden: the operator can override a verdict they disagree with.
    const anyway = screen.getByRole('button', { name: 'save anyway' });
    fireEvent.click(anyway);
    expect(saved.length).toBe(1);
  });

  test('shows progress while the probe is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    globalThis.fetch = (() => new Promise((r) => { release = r; })) as unknown as typeof fetch;
    render(<FeedDialog groupName="Street" initial={EXISTING} onSave={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'check' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'checking…' })).toBeDefined());
    release({ ok: true, status: 200, text: async () => LIVE });
  });

  test('escape cancels', () => {
    let cancelled = false;
    render(<FeedDialog groupName="Street" initial={EXISTING}
      onSave={() => {}} onCancel={() => { cancelled = true; }} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cancelled).toBe(true);
  });

  test('clicking the backdrop cancels, clicking the panel does not', () => {
    let cancelled = 0;
    render(<FeedDialog groupName="Street" initial={EXISTING}
      onSave={() => {}} onCancel={() => { cancelled += 1; }} />);
    fireEvent.click(document.querySelector('.modal__panel')!);
    expect(cancelled).toBe(0);
    fireEvent.click(document.querySelector('.modal')!);
    expect(cancelled).toBe(1);
  });
});

describe('registering a new feed', () => {
  test('names the group it will join, and cannot save without a source', () => {
    render(<FeedDialog groupName="Highway" onSave={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/Highway/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'add' }) as HTMLButtonElement).disabled).toBe(true);
    // And there is nothing to check yet either.
    expect((screen.getByRole('button', { name: 'check' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
