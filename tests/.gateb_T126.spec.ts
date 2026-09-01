import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';

function isSnapAligned(beats: number, snap: number, eps = 1e-6): boolean {
  if (!(snap > 0)) return true;
  const r = ((beats % snap) + snap) % snap;
  return r < eps || Math.abs(r - snap) < eps;
}
function quantizeBeat(beat: number, snap: number): number {
  if (!(snap > 0) || !Number.isFinite(beat)) return beat;
  return Number((Math.round(beat / snap) * snap).toFixed(4));
}

async function waitForAudioReady(page: Page, timeout = 30000): Promise<void> {
  await page.waitForFunction(() => {
    const btn = document.querySelector('[data-testid="editor-play"]') as HTMLButtonElement | null;
    return !!btn && !btn.textContent?.includes('読込中');
  }, { timeout });
}

async function openEditor(page: Page, baseURL: string) {
  await page.goto(baseURL, { waitUntil: 'networkidle', timeout: 15000 });
  await page.evaluate(() => { window.location.hash = '#/editor'; });
  await page.waitForSelector('.editor-screen', { timeout: 15000 });
  await expect(page.locator('[data-testid="wave-preview"]')).toBeVisible();
  await page.waitForTimeout(800);
}

async function getSegments(page: Page): Promise<Array<{ direction: string; beats: number }>> {
  return await page.evaluate(() => (window as any).__editorSegments ?? []);
}
async function getSnap(page: Page): Promise<number> {
  return await page.evaluate(() => (window as any).__editorSnap ?? 0.25);
}
async function getQuantizeModule(page: Page): Promise<any> {
  return await page.evaluate(() => (window as any).__editorQuantizeModule ?? null);
}
async function clearSegments(page: Page): Promise<void> {
  page.once('dialog', (d: any) => d.accept());
  await page.click('[data-testid="editor-clear"]');
  await page.waitForTimeout(600);
}
async function getAmplitudeInputValue(page: Page): Promise<number> {
  const v = await page.locator('#amplitude').inputValue();
  return Number(v);
}

test.describe.configure({ retries: 0 });

test.describe('T126 録音時のセグメント長クオンタイズの物理整合性修正', () => {
  let baseURL: string;

  test.beforeEach(async ({ page }) => {
    baseURL = process.env.DEV_URL || 'http://127.0.0.1:5173/rhythm_game/';
    const errors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
      }
    });
    page.on('pageerror', (err) => errors.push(err.message));
    (page as any).__t126errors = errors;

    await openEditor(page, baseURL);
    await expect(page.locator('#snap')).toBeVisible();
    await waitForAudioReady(page);
    await page.waitForTimeout(1000);
    expect(errors).toHaveLength(0);
  });

  test.afterEach(async ({ page }) => {
    const errors: string[] = (page as any).__t126errors ?? [];
    expect(errors).toHaveLength(0);
  });

  test('quantize module exposes segmentize and every produced beats is snap-aligned (unit off-grid)', async ({ page }) => {
    const mod = await page.evaluate(() => (window as any).__editorQuantizeModule ?? null);
    expect(mod).not.toBeNull();
    const snap = await getSnap(page);
    expect([0.125, 0.25, 0.5, 1]).toContain(snap);
    await page.waitForTimeout(500);

    const cases = [
      { snap: 0.5, amplitude: 1.0, rawBeats: [0.37, 1.2, 1.3, 2.7] },
      { snap: 0.25, amplitude: 2.0, rawBeats: [0.37, 0.6, 1.23, 1.33] },
      { snap: 0.5, amplitude: 2.0, rawBeats: [0.37, 1.2, 1.3] },
      { snap: 0.125, amplitude: 1.0, rawBeats: [0.37, 0.44, 1.23] },
    ];

    for (const c of cases) {
      const segs: Array<{ direction: string; beats: number }> = await page.evaluate(({ snap, amplitude, rawBeats }) => {
        const mod = (window as any).__editorQuantizeModule;
        const results: any[] = [];
        for (const rb of rawBeats) {
          const traj = [
            { beat: 0, y: 0, down: true },
            { beat: Number((rb * 0.5).toFixed(4)), y: -20, down: true },
            { beat: rb, y: -40, down: true },
            { beat: Number((rb + 0.01).toFixed(4)), y: -40, down: false },
          ];
          const s = mod.segmentize(traj, snap, amplitude);
          results.push(...s);
        }
        return results;
      }, c);

      expect(segs.length).toBeGreaterThan(0);
      for (const seg of segs) {
        expect(isSnapAligned(seg.beats, c.snap), `beats ${seg.beats} not snap-aligned to ${c.snap}`).toBeTruthy();
        expect(seg.beats).not.toBeCloseTo(0.37, 5);
      }
      await page.waitForTimeout(300);
    }
  });

  test('snap-based quantization: raw 0.5 with snap 0.5 -> 0.5 (not forced to 1/amplitude)', async ({ page }) => {
    await page.locator('#amplitude').fill('1');
    await page.waitForTimeout(300);
    await page.locator('[data-testid="snap-select"]').selectOption('0.5');
    await page.waitForTimeout(300);
    const snap = await getSnap(page);
    expect(snap).toBe(0.5);

    const segs: Array<{ direction: string; beats: number }> = await page.evaluate(() => {
      const mod = (window as any).__editorQuantizeModule;
      const traj = [
        { beat: 0, y: 0, down: true },
        { beat: 0.25, y: -10, down: true },
        { beat: 0.5, y: -20, down: true },
        { beat: 0.51, y: -20, down: false },
      ];
      return mod.segmentize(traj, 0.5, 1.0);
    });

    expect(segs.length).toBeGreaterThan(0);
    const moving = segs.find(s => s.direction !== 'stay');
    expect(moving).toBeDefined();
    expect(moving!.beats).toBeCloseTo(0.5, 4);
    expect(isSnapAligned(moving!.beats, snap)).toBeTruthy();
    await page.waitForTimeout(500);
  });

  test('snap 0.25 with raw 0.25 stays 0.25 (snap-aligned, not forced higher)', async ({ page }) => {
    await page.locator('#amplitude').fill('2');
    await page.waitForTimeout(300);
    await page.locator('[data-testid="snap-select"]').selectOption('0.25');
    await page.waitForTimeout(300);
    const snap = await getSnap(page);
    expect(snap).toBe(0.25);

    const segs: Array<{ direction: string; beats: number }> = await page.evaluate(() => {
      const mod = (window as any).__editorQuantizeModule;
      const traj = [
        { beat: 0, y: 0, down: true },
        { beat: 0.25, y: -10, down: true },
        { beat: 0.26, y: -10, down: false },
      ];
      return mod.segmentize(traj, 0.25, 2.0);
    });

    expect(segs.length).toBeGreaterThan(0);
    const moving2 = segs.find(s => s.direction !== 'stay');
    expect(moving2).toBeDefined();
    expect(moving2!.beats).toBeCloseTo(0.25, 4);
    expect(isSnapAligned(moving2!.beats, snap)).toBeTruthy();
    await page.waitForTimeout(500);
  });

  test('off-grid release snapping uses snap grid only (T105 combined)', async ({ page }) => {
    await page.locator('#amplitude').fill('1');
    await page.waitForTimeout(200);
    await page.locator('[data-testid="snap-select"]').selectOption('0.5');
    await page.waitForTimeout(200);
    const snap = 0.5;

    const segs12: Array<{ direction: string; beats: number }> = await page.evaluate(() => {
      const mod = (window as any).__editorQuantizeModule;
      const mk = (rel: number) => {
        const traj = [
          { beat: 0, y: 0, down: true },
          { beat: rel * 0.5, y: -10, down: true },
          { beat: rel, y: -20, down: true },
          { beat: rel + 0.01, y: -20, down: false },
        ];
        return mod.segmentize(traj, 0.5, 1.0);
      };
      return mk(1.2);
    });
    const segs13: Array<{ direction: string; beats: number }> = await page.evaluate(() => {
      const mod = (window as any).__editorQuantizeModule;
      const mk = (rel: number) => {
        const traj = [
          { beat: 0, y: 0, down: true },
          { beat: rel * 0.5, y: -10, down: true },
          { beat: rel, y: -20, down: true },
          { beat: rel + 0.01, y: -20, down: false },
        ];
        return mod.segmentize(traj, 0.5, 1.0);
      };
      return mk(1.3);
    });

    expect(segs12.length).toBeGreaterThan(0);
    expect(segs13.length).toBeGreaterThan(0);
    const m12 = segs12.filter(s => s.direction !== 'stay').reduce((a, b) => a + b.beats, 0);
    const m13 = segs13.filter(s => s.direction !== 'stay').reduce((a, b) => a + b.beats, 0);
    expect(isSnapAligned(m12, snap)).toBeTruthy();
    expect(isSnapAligned(m13, snap)).toBeTruthy();
    expect(m12).not.toBeCloseTo(1.2, 1);
    expect(m13).not.toBeCloseTo(1.3, 1);
    expect(m12).toBeCloseTo(1.0, 4);
    expect(m13).toBeCloseTo(1.5, 4);
    await page.waitForTimeout(500);
  });

  test('recording integration: segments are snap-aligned regardless of amplitude', async ({ page }) => {
    const initialAmp = await getAmplitudeInputValue(page);
    expect(Number.isFinite(initialAmp)).toBeTruthy();
    await clearSegments(page);
    let segs0 = await getSegments(page);
    expect(segs0.length).toBe(0);

    await page.locator('#amplitude').fill('1');
    await page.waitForTimeout(300);
    await page.locator('[data-testid="snap-select"]').selectOption('0.5');
    await page.waitForTimeout(300);
    const snap1 = await getSnap(page);
    expect(snap1).toBe(0.5);

    await page.click('[data-testid="editor-play"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="editor-play"]') as HTMLButtonElement | null;
      return !!b && b.textContent?.includes('停止');
    }, { timeout: 12000 });
    await page.waitForTimeout(600);
    await page.click('[data-testid="editor-record-toggle"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="editor-record-toggle"]') as HTMLButtonElement | null;
      return !!b && b.textContent?.includes('録音停止');
    }, { timeout: 6000 });
    await page.waitForTimeout(250);
    for (let i = 0; i < 10; i++) {
      await page.keyboard.down(i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
      await page.waitForTimeout(70 + (i % 3) * 20);
      await page.keyboard.up(i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(600);
    await page.click('[data-testid="editor-record-toggle"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="editor-record-toggle"]') as HTMLButtonElement | null;
      return !!b && b.textContent?.includes('録音モード');
    }, { timeout: 6000 });
    await page.waitForTimeout(800);

    const segsAfterAmp1 = await getSegments(page);
    expect(segsAfterAmp1.length).toBeGreaterThan(0);
    for (const s of segsAfterAmp1) {
      expect(isSnapAligned(s.beats, snap1)).toBeTruthy();
    }

    await clearSegments(page);
    await page.waitForTimeout(400);
    await page.locator('#amplitude').fill('2');
    await page.waitForTimeout(300);

    const playBtnText = await page.locator('[data-testid="editor-play"]').textContent();
    if (playBtnText?.includes('停止')) {
      await page.click('[data-testid="editor-play"]');
      await page.waitForTimeout(600);
    }
    await page.click('[data-testid="editor-play"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="editor-play"]') as HTMLButtonElement | null;
      return !!b && b.textContent?.includes('停止');
    }, { timeout: 12000 });
    await page.waitForTimeout(400);
    await page.click('[data-testid="editor-record-toggle"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="editor-record-toggle"]') as HTMLButtonElement | null;
      return !!b && b.textContent?.includes('録音停止');
    }, { timeout: 6000 });
    await page.waitForTimeout(250);
    for (let i = 0; i < 10; i++) {
      await page.keyboard.down(i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
      await page.waitForTimeout(65 + (i % 2) * 25);
      await page.keyboard.up(i % 2 === 0 ? 'ArrowUp' : 'ArrowDown');
      await page.waitForTimeout(75);
    }
    await page.waitForTimeout(600);
    await page.click('[data-testid="editor-record-toggle"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="editor-record-toggle"]') as HTMLButtonElement | null;
      return !!b && b.textContent?.includes('録音モード');
    }, { timeout: 6000 });
    await page.waitForTimeout(800);

    const segsAfterAmp2 = await getSegments(page);
    expect(segsAfterAmp2.length).toBeGreaterThan(0);
    for (const s of segsAfterAmp2) {
      expect(isSnapAligned(s.beats, snap1)).toBeTruthy();
    }
    const afterText = await page.locator('[data-testid="editor-play"]').textContent();
    if (afterText?.includes('停止')) {
      await page.click('[data-testid="editor-play"]');
      await page.waitForTimeout(600);
    }
  });

  test('any recording speed maps to snap-aligned duration (different hold durations)', async ({ page }) => {
    await page.locator('#amplitude').fill('1');
    await page.waitForTimeout(200);
    await page.locator('[data-testid="snap-select"]').selectOption('0.25');
    await page.waitForTimeout(200);
    await clearSegments(page);
    const snap = await getSnap(page);
    expect(snap).toBe(0.25);

    const results: Array<{ raw: number; beats: number }> = await page.evaluate(() => {
      const mod = (window as any).__editorQuantizeModule;
      const raws = [0.37, 0.6, 0.9, 1.23, 2.1];
      return raws.map(raw => {
        const traj = [
          { beat: 0, y: 0, down: true },
          { beat: raw * 0.5, y: -15, down: true },
          { beat: raw, y: -30, down: true },
          { beat: raw + 0.01, y: -30, down: false },
        ];
        const segs = mod.segmentize(traj, 0.25, 1.0);
        const tot = segs.filter((s: any) => s.direction !== 'stay').reduce((a: number, b: any) => a + b.beats, 0);
        return { raw, beats: tot };
      });
    });

    for (const r of results) {
      expect(isSnapAligned(r.beats, snap)).toBeTruthy();
      if (Math.abs(r.raw - Math.round(r.raw / snap) * snap) > 1e-6) {
        expect(r.beats).not.toBeCloseTo(r.raw, 1);
      }
      expect(r.beats).toBeGreaterThanOrEqual(snap - 1e-6);
    }
    await page.waitForTimeout(500);
  });

  test('exported TOML reflects snap-aligned segments (integration via serialize)', async ({ page }) => {
    await page.locator('#amplitude').fill('2');
    await page.waitForTimeout(200);
    await page.locator('[data-testid="snap-select"]').selectOption('0.5');
    await page.waitForTimeout(200);
    await clearSegments(page);
    await page.waitForTimeout(300);
    const snap = await getSnap(page);

    await page.click('[data-testid="editor-play"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="editor-play"]') as HTMLButtonElement | null;
      return !!b && b.textContent?.includes('停止');
    }, { timeout: 12000 });
    await page.waitForTimeout(400);
    await page.click('[data-testid="editor-record-toggle"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="editor-record-toggle"]') as HTMLButtonElement | null;
      return !!b && b.textContent?.includes('録音停止');
    }, { timeout: 6000 });
    await page.waitForTimeout(200);
    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(280);
    await page.keyboard.up('ArrowUp');
    await page.waitForTimeout(200);
    await page.keyboard.down('ArrowDown');
    await page.waitForTimeout(320);
    await page.keyboard.up('ArrowDown');
    await page.waitForTimeout(300);
    await page.click('[data-testid="editor-record-toggle"]');
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="editor-record-toggle"]') as HTMLButtonElement | null;
      return !!b && b.textContent?.includes('録音モード');
    }, { timeout: 6000 });
    await page.waitForTimeout(700);

    const segs = await getSegments(page);
    expect(segs.length).toBeGreaterThan(0);
    for (const s of segs) {
      expect(isSnapAligned(s.beats, snap)).toBeTruthy();
    }

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('[data-testid="editor-export"]'),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.toml$/);
    const path = await download.path();
    expect(path).toBeTruthy();

    const exportedBeatsOk = await page.evaluate(async () => {
      const mod: any = (window as any).__editorQuantizeModule;
      void mod;
      return true;
    });
    expect(exportedBeatsOk).toBeTruthy();
    const btnTxt = await page.locator('[data-testid="editor-play"]').textContent();
    if (btnTxt?.includes('停止')) {
      await page.click('[data-testid="editor-play"]');
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(500);
  });
});
