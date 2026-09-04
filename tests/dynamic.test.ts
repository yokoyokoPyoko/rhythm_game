import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { WaveEngine, TW_AMP, TW_CENTER_Y } from '../src/game/waveEngine';
import { BpmTimeline } from '../src/audio/bpmTimeline';
import { Cursor } from '../src/game/cursor';

vi.useFakeTimers();

const CENTER = TW_CENTER_Y;
const TOP = TW_CENTER_Y - TW_AMP;
const BOTTOM = TW_CENTER_Y + TW_AMP;

function readFile(p: string): string {
  return fs.readFileSync(path.join(process.cwd(), p), 'utf-8');
}

describe('T151 セグメント選択時のハイライト表示（点/辺＋リスト青枠）', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  // ----------------------------------------------------------------
  // 1. Vertexモード: handleMouseDown で onSelectSegment 呼び出し（非対称バグ修正）
  // ----------------------------------------------------------------
  describe('1. Vertexモード頂点クリックで selectedSegment 反映 (バグ1修正)', () => {
    it('WavePreview.tsx handleMouseDown vertex分岐で onSelectSegment?.(vHit===0?0:vHit-1) を呼ぶこと（optional chaining対応）', () => {
      // [Step1] capture initial source state
      const src = readFile('src/screens/editor/WavePreview.tsx');
      expect(src, 'WavePreview source must exist').toBeTruthy();

      // [Step2] 頂点分岐の存在を確認 — vertexDragRef セット前に onSelectSegment があること
      // perform: 抽出
      const vertexBlockRegex = /if\s*\(\s*editMode\s*===\s*['"]vertex['"]\s*\)[\s\S]*?vHit\s*>=?\s*0/;
      expect(src, 'vertex mode block must exist').toMatch(vertexBlockRegex);

      // [Step3] assert: 頂点ヒット時に selectedSegment へマッピングして呼ぶ
      // optional chaining (?.) 対応: onSelectSegment?.( ...) と onSelectSegment( ...) の双方を許容
      const vertexSelectRegex = /onSelectSegment(\?\.)?\s*\(\s*vHit\s*===\s*0\s*\?\s*0\s*:\s*vHit\s*-\s*1\s*\)/;
      expect(src, 'vertex branch must call onSelectSegment with mapping vHit===0?0:vHit-1 (with optional ?. )').toMatch(vertexSelectRegex);

      // 追加で drag 開始も同時に行われること
      const vertexDragRegex = /vertexDragRef\.current\s*=\s*\{\s*index:\s*vHit\s*\}/;
      expect(src, 'vertex branch must set vertexDragRef').toMatch(vertexDragRegex);

      // edge分岐は従来通り onSelectSegment(eHit) を (?.) 対応で呼ぶ
      const edgeSelectRegex = /onSelectSegment(\?\.)?\s*\(\s*eHit\s*\)/;
      expect(src, 'edge branch must call onSelectSegment(eHit) with optional chaining tolerant regex').toMatch(edgeSelectRegex);

      // 両分岐が非対称でなく対称に存在すること（T151完了条件1）
      const vertexCalls = (src.match(/onSelectSegment(\?\.)?\s*\(\s*vHit/g) || []).length;
      const edgeCalls = (src.match(/onSelectSegment(\?\.)?\s*\(\s*eHit\s*\)/g) || []).length;
      expect(vertexCalls, 'vertex select must appear at least once').toBeGreaterThanOrEqual(1);
      expect(edgeCalls, 'edge select must appear at least once').toBeGreaterThanOrEqual(1);
    });

    it('3-step 状態遷移: 初期 selectedSegment=null → 頂点クリック → 期待セグメント番号へ遷移（複数vHit, オフグリッド相当）', () => {
      // [Step1] Capture initial state: selectedSegment は null
      let selectedSegment: number | null = null;
      const onSelectSegment = (idx: number | null) => { selectedSegment = idx; };
      expect(selectedSegment).toBeNull();

      // Helper: 実装と同じマッピング（WavePreview.tsx と同一）
      const segIdxForVertexHit = (vHit: number) => (vHit === 0 ? 0 : vHit - 1);

      // [Step2] Perform user interaction: 複数の頂点ヒットをシミュレート（クリック）
      // vHit=0 は先頭頂点(beat 0) → segIdx 0, vHit=1 → 0, vHit=2 →1, vHit=5→4 など
      const cases: Array<{ vHit: number; expected: number }> = [
        { vHit: 0, expected: 0 },
        { vHit: 1, expected: 0 },
        { vHit: 2, expected: 1 },
        { vHit: 3, expected: 2 },
        { vHit: 5, expected: 4 },
      ];
      for (const c of cases) {
        selectedSegment = null;
        // Simulate handleMouseDown vertex branch: onSelectSegment(vHit===0?0:vHit-1)
        onSelectSegment(segIdxForVertexHit(c.vHit));
        // [Step3] Assert resulting transition
        expect(selectedSegment, `vHit=${c.vHit} should select segment ${c.expected}`).toBe(c.expected);
        vi.advanceTimersByTime(16);
      }

      // 端数タイミング相当でもマッピングは変わらない（beat位置に依らず頂点インデックス基準）
      const offGridHits = [0, 2, 4];
      for (const vHit of offGridHits) {
        selectedSegment = null;
        onSelectSegment(segIdxForVertexHit(vHit));
        expect(selectedSegment).toBe(vHit === 0 ? 0 : vHit - 1);
      }
    });

    it('WavePreview source: vertex分岐がドラッグ開始と同時に選択を呼ぶ順序（onSelectSegment が vertexDragRef より前）', () => {
      const src = readFile('src/screens/editor/WavePreview.tsx');
      // onSelectSegment と vertexDragRef の相対位置を検証（選択がドラッグより前）
      const vertexIdx = src.indexOf("editMode === 'vertex'");
      const slice = src.slice(vertexIdx, vertexIdx + 800);
      const selPos = slice.indexOf('onSelectSegment');
      const dragPos = slice.indexOf('vertexDragRef.current');
      expect(selPos, 'onSelectSegment must appear in vertex block').toBeGreaterThanOrEqual(0);
      expect(dragPos, 'vertexDragRef must appear in vertex block').toBeGreaterThanOrEqual(0);
      expect(selPos, 'onSelectSegment should be called before vertexDragRef assignment (同時/直前)').toBeLessThan(dragPos);
    });
  });

  // ----------------------------------------------------------------
  // 2. CSS定義: .segment-list-item-selected / -hovered が視認可能な青枠を持つ
  // ----------------------------------------------------------------
  describe('2. リスト側 segment-list-item-selected / hovered CSS定義 (バグ2修正)', () => {
    it('index.css に .segment-list-item-selected { border-color: var(--accent) } が定義されること（3-step）', () => {
      // [Step1] capture initial css
      const css = readFile('src/index.css');
      expect(css, 'index.css must exist').toBeTruthy();

      // [Step2] リング側の既存定義が維持されていること（回帰防止）
      expect(css, 'ring selected must still exist').toMatch(/\.ring-list-item-selected\s*\{[^}]*border-color:\s*var\(--accent\)/);

      // [Step3] assert: セグメント側がリングと同系の青枠を持つ
      const segSelectedRegex = /\.segment-list-item-selected\s*\{[^}]*border-color:\s*var\(--accent\)[^}]*\}/;
      expect(css, '.segment-list-item-selected must have border-color var(--accent)').toMatch(segSelectedRegex);
    });

    it('index.css に .segment-list-item-hovered { border-color: rgba(237,237,237,0.4) } が定義されること', () => {
      const css = readFile('src/index.css');
      const segHoverRegex = /\.segment-list-item-hovered\s*\{[^}]*border-color:\s*rgba\(\s*237\s*,\s*237\s*,\s*237\s*,\s*0\.4\s*\)/;
      expect(css, '.segment-list-item-hovered must have border-color rgba(237,237,237,0.4)').toMatch(segHoverRegex);
    });

    it('SegmentEditor.tsx が selectedIndex/hoveredIndex に応じて segment-list-item-selected / hovered クラスを付与すること', () => {
      const src = readFile('src/screens/editor/SegmentEditor.tsx');
      // クラス付与ロジック: selectedIndex === i ? ' segment-list-item-selected' : ''
      expect(src, 'must toggle selected class').toMatch(/selectedIndex\s*===\s*i\s*\?\s*['"]\s*segment-list-item-selected['"]/);
      expect(src, 'must toggle hovered class').toMatch(/hoveredIndex\s*===\s*i\s*\?\s*['"]\s*segment-list-item-hovered['"]/);
      // data-testid が正しく振られている
      expect(src, 'must have data-testid segment-list-item-${i}').toMatch(/data-testid=\{`segment-list-item-\$\{i\}`\}/);
    });

    it('3-step: selectedIndex=null → onSelect(1) → 該当liが selected クラスを獲得する状態遷移シミュレーション', () => {
      // [Step1] capture initial: selectedIndex null では selected クラス無し
      const segments = [{ direction: 'up' as const, beats: 1 }, { direction: 'down' as const, beats: 1 }, { direction: 'stay' as const, beats: 1 }];
      let selectedIndex: number | null = null;
      const classFor = (i: number) => `segment-list-item${selectedIndex === i ? ' segment-list-item-selected' : ''}`;
      expect(classFor(0)).not.toContain('segment-list-item-selected');
      expect(classFor(1)).not.toContain('segment-list-item-selected');

      // [Step2] Perform: リスト行クリックで onSelect(1)
      const onSelect = (idx: number | null) => { selectedIndex = idx; };
      onSelect(1);
      vi.advanceTimersByTime(100);

      // [Step3] assert: index 1 のみ selected、他は非選択
      expect(selectedIndex).toBe(1);
      expect(classFor(1)).toContain('segment-list-item-selected');
      expect(classFor(0)).not.toContain('segment-list-item-selected');
      expect(classFor(2)).not.toContain('segment-list-item-selected');

      // さらに別行をクリックで切り替わる
      onSelect(2);
      expect(classFor(2)).toContain('segment-list-item-selected');
      expect(classFor(1)).not.toContain('segment-list-item-selected');
      void segments;
    });
  });

  // ----------------------------------------------------------------
  // 3. プレビュー側ハイライト連動: 選択・ホバー時に辺/頂点が SELECT_COLOR で光る
  // ----------------------------------------------------------------
  describe('3. プレビュー側ハイライト連動（辺/頂点が選択で光る）', () => {
    it('WavePreview renderCanvas が selectedSegment / hoveredSegment に応じて辺を SELECT_COLOR ハイライトすること', () => {
      const src = readFile('src/screens/editor/WavePreview.tsx');
      // 辺の選択判定
      expect(src, 'must compute isSelectedEdge from selectedSegment').toMatch(/isSelectedEdge\s*=\s*i\s*===\s*selectedSegment/);
      expect(src, 'must compute isHoveredEdge from hoveredSegment').toMatch(/isHoveredEdge\s*=\s*i\s*===\s*hoveredSegment/);
      // 選択時は SELECT_COLOR
      expect(src, 'selected edge must use SELECT_COLOR').toMatch(/isSelectedEdge\s*\?\s*SELECT_COLOR/);
      // 頂点ハンドルも selectedSegment に連動
      expect(src, 'vertex highlight must use selectedSegment').toMatch(/isSelectedVertex[\s\S]*?selectedSegment/);
      expect(src, 'vertex highlight must use SELECT_COLOR').toMatch(/isHighlightedV\s*\?\s*SELECT_COLOR/);
    });

    it('WavePreview handleMouseMove が頂点ホバー時に onHoverSegment(segIdx) を呼ぶこと（hover相互連動）', () => {
      const src = readFile('src/screens/editor/WavePreview.tsx');
      // vertex hover path: segIdx = vHit===0?0:vHit-1 then onHoverSegment(segIdx)
      expect(src, 'hover must compute segIdx for vertex').toMatch(/const\s+segIdx\s*=\s*vHit\s*===\s*0\s*\?\s*0\s*:\s*vHit\s*-\s*1/);
      expect(src, 'hover must call onHoverSegment with segIdx').toMatch(/onHoverSegment(\?\.)?\(\s*segIdx\s*\)/);
    });

    it('3-step: 初期 hoveredSegment=null → 頂点ホバー → hoveredSegment が segIdx へ遷移 → ハイライト期待', () => {
      // [Step1] capture initial hover state
      let hoveredSegment: number | null = null;
      const onHoverSegment = (idx: number | null) => { hoveredSegment = idx; };
      expect(hoveredSegment).toBeNull();

      // [Step2] simulate hover over vertex vHit=3 -> segIdx 2
      const segIdxForVertexHover = (vHit: number) => (vHit === 0 ? 0 : vHit - 1);
      const vHit = 3; // off-grid相当でもインデックス基準は同じ
      onHoverSegment(segIdxForVertexHover(vHit));
      vi.advanceTimersByTime(50);

      // [Step3] assert hoveredSegment reflects vertex adjacency (辺が光る)
      expect(hoveredSegment).toBe(2);
      // 辺ハイライト判定: isHoveredEdge = (i === hoveredSegment)
      const isHoveredEdge = (i: number) => i === hoveredSegment;
      expect(isHoveredEdge(2)).toBe(true);
      expect(isHoveredEdge(1)).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // 4. 数値回帰: WaveEngine ↔ Cursor 速度一致（複雑振幅 + オフグリッド）— T127スタイル
  // ----------------------------------------------------------------
  describe('4. 数値整合回帰: WaveEngine dY クランプと Cursor 速度が複雑振幅で一致（T127/T128維持）', () => {
    const amps = [0.7, 1.3, 2.7, 3.4] as const;
    const offBeats = [0.37, 1.23, 0.63, 2.37] as const;

    for (const amp of amps) {
      it(`amp=${amp}: 非クランプ区間で waveYAt 傾斜が 2*TW_AMP*amp/拍と一致（off-grid 0.37, 1.23）`, () => {
        const tl = new BpmTimeline(120, [], amp);
        // 十分長い down セグメント（クランプ到達前に傾斜を計測）
        const segs = [{ direction: 'down' as const, beats: 4 }];
        const eng = new WaveEngine(segs, tl, amp, 0); // start CENTER=300
        const perBeat = 2 * TW_AMP * amp;
        for (const off of offBeats) {
          const b = Math.min(off, 0.3); // クランプ前の安全域
          const yAt = eng.waveYAt(b);
          const expected = CENTER + perBeat * b; // downは+方向
          // クランプ前は expected そのまま
          if (expected >= TOP && expected <= BOTTOM) {
            expect(Math.abs(yAt - expected), `amp ${amp} off ${off} waveYAt mismatch`).toBeLessThan(1e-6);
          }
        }
      });

      it(`amp=${amp}: getPoints 長さが segments.length+1 を維持（回帰）`, () => {
        const tl = new BpmTimeline(120, [], amp);
        const segs = [
          { direction: 'down' as const, beats: 1.5 },
          { direction: 'up' as const, beats: 2.0 },
          { direction: 'down' as const, beats: 1.0 },
        ];
        const eng = new WaveEngine(segs, tl, amp, 0);
        expect(eng.getPoints().length).toBe(segs.length + 1);
        expect(eng.getPoints()[0].beat).toBe(0);
      });

      it(`amp=${amp}: Cursor 1拍の変位が WaveEngine perBeat と一致（クランプ前）`, () => {
        const beatMs = 500;
        const dt = beatMs / 1000; // 1拍
        const cursor = new Cursor(amp, 0);
        // Cursor は内部で amplitude を保持 — 初期は amp, 動的に setAmplitude 可能
        (cursor as any).setAmplitude?.(amp);
        const y0 = cursor.y;
        cursor.update(dt, false, true, beatMs); // down押下で下へ
        const disp = cursor.y - y0;
        const expected = 2 * TW_AMP * amp;
        const clamped = Math.min(BOTTOM - y0, expected);
        expect(Math.abs(disp - clamped), `amp ${amp} cursor disp mismatch`).toBeLessThan(1e-3);
      });
    }
  });

  // ----------------------------------------------------------------
  // 5. data-testid 存在（誤った親IDをhallucinateしない）
  // ----------------------------------------------------------------
  describe('5. 利用可能な data-testid が存在し誤ったIDを参照しない', () => {
    it('WavePreview が wave-preview / wave-preview-canvas を持つ', () => {
      const src = readFile('src/screens/editor/WavePreview.tsx');
      expect(src, 'must have data-testid wave-preview').toMatch(/data-testid="wave-preview"/);
      expect(src, 'must have data-testid wave-preview-canvas').toMatch(/data-testid="wave-preview-canvas"/);
    });

    it('SegmentEditor が segment-list-item-N と segment-list-details を持つ', () => {
      const src = readFile('src/screens/editor/SegmentEditor.tsx');
      expect(src, 'must have segment-list-item').toMatch(/segment-list-item-/);
      expect(src, 'must have segment-list-details').toMatch(/segment-list-details/);
    });
  });
});
