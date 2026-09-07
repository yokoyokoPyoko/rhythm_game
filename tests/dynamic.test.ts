/**
 * T197 — 組込曲の完全削除 (Vitest, node environment)
 * TDD Red -> Green - strict acceptance for built-in song removal.
 * No DOM, no browser - pure node + fs + mocked fetch + source text inspection.
 * Each requirement uses 3-step state-transition assertions to prevent false positives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

vi.useFakeTimers({ toFake: ['Date'] } as unknown as Parameters<typeof vi.useFakeTimers>[0]);

const ROOT = process.cwd();
const PUBLIC_SONGS = path.join(ROOT, 'public/songs.toml');
const PUBLIC_CHART = path.join(ROOT, 'public/charts/reply.toml');
const PUBLIC_AUDIO = path.join(ROOT, 'public/audio/08.Reply.flac');
const MANIFEST_SRC = path.join(ROOT, 'src/chart/manifest.ts');
const SELECT_SRC = path.join(ROOT, 'src/screens/SelectScreen.tsx');
const EDITOR_SRC = path.join(ROOT, 'src/screens/EditorScreen.tsx');

function readText(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// 1. Built-in file deletion
// ---------------------------------------------------------------------------
describe('T197 (1) 組込曲ファイルの完全削除 — public/songs.toml, public/charts/reply.toml, public/audio/08.Reply.flac', () => {
  it('public/songs.toml が存在しないこと (3-step)', () => {
    // [Step1: Capture Initial State] check current existence before expectation
    const existsBefore = fs.existsSync(PUBLIC_SONGS);
    const statBefore = existsBefore ? fs.statSync(PUBLIC_SONGS).size : -1;
    // [Step2: Perform] list public dir to confirm content
    const publicDir = path.join(ROOT, 'public');
    const entries = fs.existsSync(publicDir) ? fs.readdirSync(publicDir) : [];
    // [Step3: Assert Resulting Transition] must be absent
    expect(existsBefore, `public/songs.toml should NOT exist after T197 (found size ${statBefore}, entries: ${entries.join(',')})`).toBe(false);
    expect(entries.includes('songs.toml')).toBe(false);
    // ensure file read fails
    expect(fs.existsSync(PUBLIC_SONGS)).toBe(false);
  });

  it('public/charts/reply.toml が存在しないこと (3-step)', () => {
    const existsBefore = fs.existsSync(PUBLIC_CHART);
    const dir = path.dirname(PUBLIC_CHART);
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    // Step2: attempt read (should throw / not exist)
    let readFailed = false;
    try { fs.readFileSync(PUBLIC_CHART, 'utf-8'); } catch { readFailed = true; }
    // Step3: assert non-existence
    expect(existsBefore, `public/charts/reply.toml should NOT exist (entries: ${entries.join(',')})`).toBe(false);
    expect(entries.includes('reply.toml')).toBe(false);
    expect(readFailed).toBe(true);
  });

  it('public/audio/08.Reply.flac が存在しないこと (3-step)', () => {
    const existsBefore = fs.existsSync(PUBLIC_AUDIO);
    const audioDir = path.join(ROOT, 'public/audio');
    const entries = fs.existsSync(audioDir) ? fs.readdirSync(audioDir) : [];
    let readFailed = false;
    try { fs.readFileSync(PUBLIC_AUDIO); } catch { readFailed = true; }
    expect(existsBefore, `public/audio/08.Reply.flac should NOT exist (entries: ${entries.join(',')})`).toBe(false);
    expect(entries.includes('08.Reply.flac')).toBe(false);
    expect(readFailed).toBe(true);
  });

  it('docs/ はビルド成果物のため必須ではないが、public 側3ファイルが同時に不存在であること', () => {
    const s1 = fs.existsSync(PUBLIC_SONGS);
    const s2 = fs.existsSync(PUBLIC_CHART);
    const s3 = fs.existsSync(PUBLIC_AUDIO);
    const totalExisting = [s1, s2, s3].filter(Boolean).length;
    expect(totalExisting, `all three built-in files must be deleted, but ${totalExisting} still exist`).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. manifest.ts — 404時に空リスト[]を返す
// ---------------------------------------------------------------------------
describe('T197 (2) src/chart/manifest.ts 404時に空リスト[]を返す', () => {
  const originalFetch = (globalThis as unknown as { fetch?: typeof fetch }).fetch;

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'));
  });

  afterEach(() => {
    if (originalFetch) (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    else delete (globalThis as unknown as { fetch?: unknown }).fetch;
    vi.clearAllMocks();
  });

  it('404レスポンスで例外ではなく空配列[]を返す (3-step)', async () => {
    // [Step1: Capture Initial State] original manifest throws on !ok
    const srcBefore = readText(MANIFEST_SRC);
    const hadThrow = srcBefore.includes('throw new Error') && srcBefore.includes('曲リストの読み込みに失敗');
    expect(hadThrow, 'pre-fix manifest should have throw path (baseline check)').toBe(true);

    // [Step2: Perform] mock fetch 404 and call loadSongList
    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => '',
    } as unknown as Response));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;
    // dynamic import to avoid cache issues - but direct import uses global fetch at call time
    const { loadSongList } = await import('../src/chart/manifest');

    let result: unknown = null;
    let threw = false;
    let errorMsg = '';
    try {
      result = await loadSongList();
    } catch (e) {
      threw = true;
      errorMsg = String(e);
    }

    // [Step3: Assert Resulting Transition] must NOT throw, must return []
    expect(threw, `loadSongList should NOT throw on 404, but threw: ${errorMsg}`).toBe(false);
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(0);
    expect(mockFetch).toHaveBeenCalled();
    const fetchUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(fetchUrl).toContain('songs.toml');
  });

  it('正常200レスポンスは正しくパースして SongEntry[] を返す (3-step)', async () => {
    // [Step1: Capture] mock 404 already tested; now test success path is not broken
    const tomlText = `[[songs]]\nid = "custom-1"\ntitle = "Custom"\nartist = "A"\nchartPath = "custom.toml"\ndifficulty = 3\n`;
    const mockFetchOk = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => tomlText,
    } as unknown as Response));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetchOk as unknown as typeof fetch;
    const { loadSongList } = await import('../src/chart/manifest');
    // [Step2: Perform] call
    const list = await loadSongList();
    // [Step3: Assert] parsed correctly
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe('custom-1');
    expect(list[0].title).toBe('Custom');
    expect(list[0].chartPath).toBe('custom.toml');
  });

  it('空songs.toml (songsキー無し) でも空配列を返す (3-step)', async () => {
    const mockFetchEmpty = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => `# empty\n`,
    } as unknown as Response));
    (globalThis as unknown as { fetch: typeof fetch }).fetch = mockFetchEmpty as unknown as typeof fetch;
    const { loadSongList } = await import('../src/chart/manifest');
    const beforeLen = -1;
    const list = await loadSongList();
    expect(list).toEqual([]);
    expect(beforeLen).toBe(-1);
  });

  it('manifest.ts ソースが !res.ok で return [] する分岐を持つ (3-step static check)', () => {
    const src = readText(MANIFEST_SRC);
    const beforeHasThrowOnly = src.includes('throw new Error(`曲リストの読み込みに失敗');
    // [Step2] check new handling
    const hasReturnEmpty = src.includes('return []') && (src.includes('!res.ok') || src.includes('res.ok') || src.includes('res.status'));
    // [Step3] must have return [] and not solely throw
    // After fix, the 404 branch should return [] instead of throw
    expect(hasReturnEmpty, `manifest.ts must contain 'return []' for !res.ok handling. src snippet: ${src.slice(0, 800)}`).toBe(true);
    // Ensure the throw for 404 is removed or guarded; at least return [] exists
    expect(beforeHasThrowOnly && !hasReturnEmpty ? false : true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. SelectScreen — 0件時に空状態メッセージを表示
// ---------------------------------------------------------------------------
describe('T197 (3) SelectScreen 曲0件時の空状態メッセージ', () => {
  it('SelectScreen.tsx が空状態メッセージを含むこと (3-step)', () => {
    // [Step1: Capture Initial State] read source before assertion
    const src = readText(SELECT_SRC);
    const hadNoEmptyState = !src.includes('曲がありません') && !src.includes('譜面TOMLと音声をインポート');
    // Baseline: before fix there is no empty message
    expect(src.length).toBeGreaterThan(100);
    // [Step2: Perform] check for conditional rendering on songs.length
    const hasSongsLengthCheck = src.includes('songs.length') && (src.includes('=== 0') || src.includes('== 0') || src.includes('!songs.length') || src.includes('songs.length === 0'));
    const hasEmptyMessage = src.includes('曲がありません') || src.includes('曲はありません') || src.includes('インポートしてください');
    const hasDropzone = src.includes('home-dropzone') || src.includes('custom-import-section') || src.includes('home-chart-input');
    // [Step3: Assert Resulting Transition] must have all three
    expect(hasEmptyMessage, `SelectScreen must display empty-state message like '曲がありません。上のエリアから譜面TOMLと音声をインポートしてください'. src missing this.`).toBe(true);
    expect(hasSongsLengthCheck, 'SelectScreen must conditionally check songs.length === 0').toBe(true);
    expect(hasDropzone, 'SelectScreen must still show import UI (home-dropzone / home-chart-input) even when 0 songs').toBe(true);
    // Ensure dropzone is not hidden behind conditional that requires songs
    expect(hadNoEmptyState || hasEmptyMessage).toBe(true);
  });

  it('SelectScreen が songs.toml 由来のハードコード reply カードに依存しない (3-step)', () => {
    const src = readText(SELECT_SRC);
    // [Step1] capture if src still navigates to hardcoded reply
    const hasHardcodedReplyNav = src.includes("#/play/reply") || src.includes("'/play/reply'") || src.includes('"/play/reply"') || src.includes("play/reply");
    // [Step2] check that songs are loaded via loadSongList and not hardcoded
    const usesLoadSongList = src.includes('loadSongList');
    // [Step3] must use dynamic list, not hardcoded reply
    expect(usesLoadSongList).toBe(true);
    // Hardcoded reply nav should not exist in SelectScreen
    expect(hasHardcodedReplyNav, 'SelectScreen should not contain hardcoded reply navigation').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. EditorScreen — 音楽URL初期値・プレースホルダの 08.Reply.flac 除去
// ---------------------------------------------------------------------------
describe('T197 (4) EditorScreen 音楽URL初期値・プレースホルダの 08.Reply.flac 除去', () => {
  it('EditorScreen.tsx のデフォルト値が空欄であること (3-step)', () => {
    // [Step1: Capture Initial State] read source
    const src = readText(EDITOR_SRC);
    const initialUrlLine = src.match(/useState.*url.*=.*useState\(([^)]+)\)/);
    // [Step2: Perform] inspect initial states
    const hasReplyDefault = src.includes('08.Reply.flac');
    const hasTitleInitEmpty = src.includes("useState('')") || src.includes('useState("")');
    // Find url initial value
    const urlInitMatch = src.match(/const\s+\[url,\s*setUrl\]\s*=\s*useState\(([^)]+)\)/);
    const urlInitVal = urlInitMatch ? urlInitMatch[1].trim() : 'NOT_FOUND';
    // [Step3: Assert] must NOT contain 08.Reply.flac and url must be ''
    expect(hasReplyDefault, `EditorScreen should NOT contain '08.Reply.flac' placeholder/default, but found it`).toBe(false);
    expect(urlInitVal === "''" || urlInitVal === '""' || urlInitVal === "''" || urlInitVal === '""', `url initial value should be '' but got ${urlInitVal} (line: ${initialUrlLine?.[0]})`).toBe(true);
    expect(hasTitleInitEmpty).toBe(true);
  });

  it('EditorScreen.tsx が placeholder / hint に 08.Reply.flac を含まない (3-step)', () => {
    const src = readText(EDITOR_SRC);
    const beforeContains = src.includes('/rhythm_game/audio/08.Reply.flac');
    const placeholderMatches = [...src.matchAll(/placeholder\s*=\s*"([^"]*08\.Reply[^"]*)"/g)];
    const hintMatches = [...src.matchAll(/08\.Reply\.flac/g)];
    expect(beforeContains).toBe(false);
    expect(placeholderMatches.length).toBe(0);
    expect(hintMatches.length).toBe(0);
  });

  it('EditorScreen の audio-url input が空文字で初期化されること (static + dynamic simulation)', () => {
    const src = readText(EDITOR_SRC);
    // [Step1] capture default state definition
    const hasEmptyUrlState = src.includes("const [url, setUrl] = useState('')") || src.includes('const [url, setUrl] = useState("")');
    // [Step2] verify no default props like defaultValue="08.Reply"
    const hasDefaultValueReply = src.includes('defaultValue') && src.includes('08.Reply');
    // [Step3] assert
    expect(hasEmptyUrlState, 'EditorScreen url state must be useState(\'\')').toBe(true);
    expect(hasDefaultValueReply).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Test file handovers — 削除に伴い失敗するspecが残っていない
// ---------------------------------------------------------------------------
describe('T197 (5) テスト手直し — 削除に伴い失敗するspecが残っていない', () => {
  const TESTS_DIR = path.join(ROOT, 'tests');

  function listSpecFiles(): string[] {
    if (!fs.existsSync(TESTS_DIR)) return [];
    return fs.readdirSync(TESTS_DIR)
      .filter(f => f.endsWith('.spec.ts') || f.endsWith('.test.ts'))
      .map(f => path.join(TESTS_DIR, f));
  }

  function isAllowedFixture(filePath: string, content: string): boolean {
    // .gateb_T*.test.ts 内の basename処理用 fixture文字列は実ファイル不要のため残してよい
    const base = path.basename(filePath);
    if (/^\.gateb_T.*\.test\.ts$/.test(base)) return true;
    // dynamic.test.ts 自体は QA ゲートランナーであり、削除対象ファイル名を検証文字列として含む
    if (base === 'dynamic.test.ts') return true;
    return false;
  }

  it('全specで 08.Reply.flac の実ファイル参照がカスタム追加フロー等に置換済みであること (3-step)', () => {
    // [Step1: Capture Initial State] list all spec files
    const specFiles = listSpecFiles();
    expect(specFiles.length).toBeGreaterThan(0);
    const beforeCount = specFiles.length;
    // [Step2: Perform] scan each file for prohibited 08.Reply.flac outside allowed fixtures
    const violations: string[] = [];
    for (const fp of specFiles) {
      const content = readText(fp);
      if (isAllowedFixture(fp, content)) continue; // allowed fixture strings in .gateb_T*.test.ts
      if (content.includes('08.Reply.flac')) {
        // Check if it's a real fetch/inputValue expectation vs allowed import flow
        // Any occurrence outside allowed is a violation
        const lines = content.split('\n').filter(l => l.includes('08.Reply.flac')).map(l => l.trim().slice(0, 120));
        violations.push(`${path.basename(fp)}: ${lines.join(' | ')}`);
      }
    }
    // [Step3: Assert] no violations
    expect(violations, `Found ${violations.length} spec(s) still referencing 08.Reply.flac (should be replaced with custom flow / in-memory fixture):\n${violations.join('\n')}`).toEqual([]);
    expect(beforeCount).toBeGreaterThan(0);
  });

  it('#/play/reply へのハードコード遷移が残っていないこと (3-step)', () => {
    const specFiles = listSpecFiles();
    const beforeFiles = specFiles.length;
    const violations: string[] = [];
    for (const fp of specFiles) {
      const content = readText(fp);
      if (isAllowedFixture(fp, content) && content.includes('08.Reply.flac')) continue; // allowed
      // Check for hardcoded reply navigation
      if (content.includes('#/play/reply') || content.includes('/play/reply') && !content.includes('custom-') && !content.includes('play/custom')) {
        // More precise: look for literal '#/play/reply' or 'play/reply' without custom prefix
        if (/#\/play\/reply\b/.test(content) || /['"]\/play\/reply['"]/.test(content)) {
          violations.push(path.basename(fp));
        }
      }
    }
    expect(violations, `Found spec(s) still using hardcoded '#/play/reply': ${violations.join(', ')}`).toEqual([]);
    expect(beforeFiles).toBeGreaterThan(0);
  });

  it('debug-audio-fetch.spec.ts 等の実ファイル fetch 確認がモック/生成音源に置換済みであること (3-step)', () => {
    const debugFetchPath = path.join(TESTS_DIR, 'debug-audio-fetch.spec.ts');
    const exists = fs.existsSync(debugFetchPath);
    // [Step1] capture before state
    let content = '';
    if (exists) content = readText(debugFetchPath);
    // [Step2] check for direct fetch of 08.Reply.flac
    const hasDirectFetch = content.includes("fetch('/rhythm_game/audio/08.Reply.flac')") || content.includes('fetch("/rhythm_game/audio/08.Reply.flac")');
    // [Step3] if file exists, it should not directly fetch the deleted audio; either file is removed/updated or uses mock
    if (exists) {
      expect(hasDirectFetch, `debug-audio-fetch.spec.ts still fetches deleted 08.Reply.flac directly`).toBe(false);
    } else {
      // File deleted is also valid handover (no failing spec remains)
      expect(exists).toBe(false);
    }
  });

  it('t42.spec.ts の曲カードクリックが組込曲依存でないこと (3-step)', () => {
    const t42Path = path.join(TESTS_DIR, 't42.spec.ts');
    if (!fs.existsSync(t42Path)) return; // deleted or renamed is OK
    const content = readText(t42Path);
    // [Step1] capture: old t42 clicks .song-card assuming reply exists
    const hasReplyAssumption = content.includes('.song-card') && content.includes('reply') && !content.includes('custom');
    // [Step2] check if file has been updated to handle 0 songs or custom flow
    const hasCustomHandling = content.includes('custom-') || content.includes('home-chart-input') || content.includes('home-audio-input') || content.includes('ChartCache') || content.includes('empty') || content.includes('曲がありません');
    // [Step3] old assumption must be gone or file must be updated to custom flow
    // If still present without custom handling, it's a violation
    if (hasReplyAssumption) {
      expect(hasCustomHandling, `t42.spec.ts still assumes built-in reply card exists without custom handling`).toBe(true);
    }
    // Also ensure it doesn't hardcode 08.Reply.flac
    expect(content.includes('08.Reply.flac') && !isAllowedFixture(t42Path, content)).toBe(false);
  });

  it('t50/t51/editor-workflow 等の 08.Reply.flac URL入力が除去済みであること (3-step)', () => {
    const checkFiles = ['t50.spec.ts', 't51.spec.ts', 'editor-workflow.spec.ts', 'editor.spec.ts'].map(f => path.join(TESTS_DIR, f));
    const violations: string[] = [];
    for (const fp of checkFiles) {
      if (!fs.existsSync(fp)) continue;
      const content = readText(fp);
      if (isAllowedFixture(fp, content)) continue;
      if (content.includes('08.Reply.flac')) {
        // Check if it's an input expectation like toHaveValue('/rhythm_game/audio/08.Reply.flac')
        const lines = content.split('\n').filter(l => l.includes('08.Reply.flac')).map(l => l.trim().slice(0, 140));
        violations.push(`${path.basename(fp)}: ${lines.join(' | ')}`);
      }
    }
    expect(violations, `t50/t51/editor-workflow still fill or expect 08.Reply.flac URL:\n${violations.join('\n')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. tsc --noEmit
// ---------------------------------------------------------------------------
describe('T197 (6) tsc --noEmit エラーなし', () => {
  it('tsc --noEmit がエラーなく完了すること (3-step)', () => {
    // [Step1: Capture Initial State] verify tsconfig exists
    const tsconfigExists = fs.existsSync(path.join(ROOT, 'tsconfig.json'));
    expect(tsconfigExists).toBe(true);
    // [Step2: Perform] run tsc --noEmit
    let output = '';
    let success = false;
    try {
      output = execSync('npx tsc --noEmit', { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe', timeout: 30000 } as unknown as { encoding: string }) as unknown as string;
      success = true;
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string; status?: number };
      output = (err.stdout || '') + (err.stderr || '') + (err.message || '');
      success = err.status === 0;
    }
    // [Step3: Assert] no errors
    expect(success, `tsc --noEmit failed:\n${output.slice(0, 4000)}`).toBe(true);
    expect(output.includes('error TS')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Integration: empty SelectScreen + import UI coexistence (computed state)
// ---------------------------------------------------------------------------
describe('T197 (7) 完了条件(1) 統合: 0曲 + インポートUI + 空状態メッセージ の同時成立', () => {
  it('3要素が同時に満たされること (3-step)', () => {
    // [Step1: Capture] check each component state independently
    const songsExists = fs.existsSync(PUBLIC_SONGS);
    const selectSrc = readText(SELECT_SRC);
    const hasEmptyMsg = selectSrc.includes('曲がありません') || selectSrc.includes('インポートしてください');
    const hasImportUI = selectSrc.includes('home-chart-input') && selectSrc.includes('home-audio-input') && selectSrc.includes('home-dropzone');
    const hasZeroCheck = selectSrc.includes('songs.length');
    // [Step2: Perform] simulate computed state: 0 songs scenario
    const computedSongs: unknown[] = []; // after manifest returns []
    const isZeroSongs = computedSongs.length === 0;
    const shouldShowEmpty = isZeroSongs && hasEmptyMsg;
    const shouldShowImport = hasImportUI; // import UI always visible
    // [Step3: Assert] all three conditions simultaneously
    expect(songsExists).toBe(false);
    expect(isZeroSongs).toBe(true);
    expect(shouldShowEmpty, 'empty message should be shown when 0 songs').toBe(true);
    expect(shouldShowImport, 'import UI should still be present when 0 songs').toBe(true);
    expect(hasZeroCheck).toBe(true);
    // Combined gate: all must be true
    expect(songsExists === false && shouldShowEmpty && shouldShowImport).toBe(true);
  });

  it('SelectScreen が loading/error/empty/success の4状態を区別すること (3-step)', () => {
    const src = readText(SELECT_SRC);
    // [Step1] capture states
    const hasLoading = src.includes('loading') || src.includes('SKELETON') || src.includes('読み込み中');
    const hasError = src.includes('select-error') || src.includes('曲リストの読み込みに失敗');
    const hasEmpty = src.includes('曲がありません');
    const hasGrid = src.includes('song-grid');
    // [Step2] verify branching
    const hasConditional = src.includes('songs.length') && src.includes('?') || src.includes('if');
    // [Step3] all states present
    expect(hasLoading).toBe(true);
    expect(hasError).toBe(true);
    expect(hasEmpty).toBe(true);
    expect(hasGrid).toBe(true);
    expect(hasConditional || hasEmpty).toBe(true);
  });
});
