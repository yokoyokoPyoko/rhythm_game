# AGENTS.md — リズムゲーム自律開発仕様書

対象読者: AIエージェント（実装者）
このファイルを必ず最初に読め。各タスクIDの仕様セクションのみを参照して実装すること。

---

## 行動ルール（全タスク共通・最優先）

1. **質問禁止**: 不明点は自分で最善を判断して実装。迷ったら最もシンプルな実装を選ぶ。
2. **ゲーミング禁止**: 虹色・過剰グロー・パーティクル爆発・レインボーRGBは一切使わない。
3. **スコープ厳守**: 当該タスクの仕様に書いてない機能を追加しない。追加したい場合はTODOコメントのみ。
4. **ビルドエラー即修正**: `tsc --noEmit` エラーは次ファイルを触る前に必ず修正。
5. **依存ファイル更新の徹底**: 仕様変更（型定義やチャートフォーマットの変更など）を行う際は、必ず依存関係にあるファイル（loader, serializer, engine, component, test等）を検索し、全ての関連箇所を一括で修正すること。変更漏れによるランタイムエラーは重大な失敗とみなす。
6. **迷ったらLinear**: デザイン判断はLinear.app / Vercel dashboardを基準にする。
7. **詰まったら30分でスキップ**: 30分解決しなければTODOコメントを書いて次タスクへ。
8. **オフグリッド検証原則**: クオンタイズ・スナップ・タイミング判定を実装・テストする際は、グリッド境界（整数拍）だけでなく、必ずグリッド間の端数タイミング（例: 0.37拍、1.23拍など）での入力を扱い、正しく最近傍に吸着されること（偽陽性防止）を確認すること。

---

## プロジェクト概要

文化祭展示用リズムゲーム。ブラウザ(Chrome)で動作。GitHub Pages公開。

- **ゲームタイトル**: トレース・ウェーブ（Trace Wave）
- **リポジトリ**: `/home/p-yoko/Program/TypeScript/rhythm_game/`（既存。全て書き直す）
- **デプロイ**: `npm run build` → `docs/` に出力 → `git push` → GitHub Pages

---

## 技術スタック

- Vite + React 18 + TypeScript
- smol-toml (TOMLパーサー)
- react-router-dom v6 (HashRouter使用。GitHub Pages対応)
- CSS Variables のみ (外部UIライブラリ禁止)
- Web Audio API (音声・タイミング)
- Canvas 2D (ゲーム描画)

**Vite設定**: `build.outDir = "docs"` かつ `base = "/rhythm_game/"` (GitHub Pages用)

---

## ゲームデザイン仕様

### 波形（Wave）システム
- チャートで定義された折れ線（セグメント列）。純粋な三角波ではない。
- 各セグメント: `{ direction: "up" | "down", beats: number }`
- カーソルは↑↓キーで移動。速度 = `(2 * TW_AMP) / (segmentBeats * (beatMs / 1000))` px/sec（segmentBeats=現在のセグメント拍数。波形の斜度と一致させる）
- 初期位置: 上端 `TW_CENTER_Y - TW_AMP`（波形のピーク位置）

### リングシステム
- チャートで独立して配置。波形のカドと無関係にどのbeat位置にも置ける。
- リングは画面右からスクロールし、hitTimeちょうどに判定線に到達。
- リングのY座標 = `waveYAt(hitBeat)`（その拍での波形のY位置）

### ヒット判定
- タイミング誤差: `|pressTime - ring.hitTime| < beatMs * 0.4`
- Y距離: `|cursorY - ring.targetY| < 60` px
- 両方満たしてヒット。
- PERFECT: 誤差 < 50ms AND Y距離 < 30px
- GOOD: それ以外のヒット
- MISS: ウィンドウ超過 or 未押し

### スコア・ランク
- PERFECT: 300点、GOOD: 100点、MISS: コンボリセット
- トレースボーナス: カーソルが波形±26px内で0.15秒ごとにcombo+1、score+8+combo
- ランク: S=95%PERFECT以上、A=80%、B=60%、C=40%、D=それ以下

### 重要定数
```
TW_JUDGE_X = Math.round(800 * 0.26)
TW_CENTER_Y = 600 / 2
TW_AMP = 80
TW_SCROLL = 110
TW_LEAD_BEATS = 3
TW_TOLERANCE = 26
```

---

## オーディオアーキテクチャ

- 基準クロック: `audioCtx.currentTime` のみ
- ゲーム時刻: `songNow() = (audioCtx.currentTime - audioStartTime) * 1000` (ms)
- Space押下: keydownイベント内で即座にaudioCtx.currentTimeを保存
- メトロノーム: lookahead=200msで先読みスケジュール
- 音楽ファイル: `public/audio/` に置き、相対URLで参照
  - 例: `audio = "/rhythm_game/audio/08.Reply.flac"`
- manualOffsetMs: localStorageに保存、メトロノームスケジュールに加算

---

## チャートフォーマット（TOML）

```toml
title = "Reply"
artist = ""
bpm = 120
audio = "/rhythm_game/audio/08.Reply.flac"

[[bpm_changes]]
beat = 64
bpm = 150

[[segments]]
direction = "up"
beats = 2

[[segments]]
direction = "down"
beats = 2

[[rings]]
beat = 4.0

[[rings]]
beat = 8.0
```

---

## 曲マニフェスト (public/songs.toml)

```toml
[[songs]]
id = "reply"
title = "Reply"
artist = ""
chartPath = "/rhythm_game/charts/reply.toml"
difficulty = 5
```

---

## デザインシステム

```css
--bg: #0a0a0a;
--bg-surface: #111111;
--border: rgba(255,255,255,0.08);
--text: #ededed;
--text-muted: #71717a;
--accent: #6366f1;
--accent-sub: #22d3ee;
--positive: #4ade80;
--warning: #fbbf24;
--danger: #f87171;
--radius: 8px;
--font: 'Inter', system-ui, sans-serif;
```

禁止: 色付きグロー多用・派手なグラデーション背景・ネオン発光・ゲーミング風
許可: 白の微グロー・opacity/transformアニメーション・アクセントカラー単色使用

---

## タスク別仕様

### [T82] Playwright スモークテスト

`tests/smoke.spec.ts` を作成:
```typescript
import { test, expect } from '@playwright/test';
test('smoke test', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const t = msg.text();
      if (/Uncaught|ReferenceError|TypeError|ChunkLoadError/.test(t)) errors.push(t);
    }
  });
  await page.goto('http://localhost:5173/');
  await page.waitForLoadState('networkidle', { timeout: 5000 });
  await expect(page.locator('#root')).toBeVisible();
  await page.waitForTimeout(2000);
  expect(errors).toHaveLength(0);
});
```

`playwright.config.ts` も作成 (headless:true, chromium)。

---

### [T00] プロジェクトスキャフォールド

既存の src/ と docs/ を削除し、Vite+React+TSを新規作成:

```bash
rm -rf src docs
npm create vite@latest . -- --template react-ts
npm install
npm install smol-toml react-router-dom
npm install -D @playwright/test
npx playwright install chromium
```

vite.config.ts に追加:
```typescript
export default defineConfig({
  base: '/rhythm_game/',
  build: { outDir: 'docs', emptyOutDir: true },
  plugins: [react()],
})
```

public/audio/.gitkeep, public/charts/.gitkeep を作成。
public/charts/reply.toml を仮データで作成（上記チャートフォーマット参照）。
public/songs.toml を作成（上記マニフェスト参照）。

完了条件: `npm run dev` でブラウザ表示。`tsc --noEmit` エラーなし。

---

### [T01] TypeScript型定義

`src/types.ts`:

```typescript
export interface Segment { direction: 'up' | 'down'; beats: number; }
export interface BpmChange { beat: number; bpm: number; }
export interface RingDef { beat: number; }
export interface Chart {
  title: string; artist: string; bpm: number; audio: string;
  bpm_changes: BpmChange[]; segments: Segment[]; rings: RingDef[];
}
export interface SongEntry {
  id: string; title: string; artist: string; chartPath: string; difficulty: number;
}
export interface RingState {
  id: number; spawnTime: number; hitTime: number; targetY: number;
  resolved: boolean; hit: boolean;
}
export type HitResult = 'perfect' | 'good' | 'miss';
export type GameMode = 'select' | 'playing' | 'result' | 'editor' | 'calibration';
export interface HitJudgement { result: HitResult; errorMs: number; }
```

---

### [T02] CSSデザインシステム

src/index.css を上書き。上記デザインシステムのCSS変数を定義。
body: background=var(--bg), color=var(--text), font-family=var(--font)。
* { box-sizing: border-box; margin: 0; padding: 0; }
index.html の <head> に Inter フォント (Google Fonts) を追加。
src/App.css を削除。

---

### [T10] AudioContextマネージャ

`src/audio/AudioManager.ts`:
- シングルトンパターン
- `ensure()`: ユーザー操作後にAudioContextを初期化・resume
- `get ctx()`, `get baseLatency()`, `get outputLatency()`

---

### [T11] メトロノームスケジューラ

`src/audio/metronome.ts`:
- lookahead=200ms
- `schedule(audioCtx, nextBeatTime, beat, latency)` で音を予約
- 強拍(beat%4===0): 880Hz, 弱拍: 440Hz, 短いクリック音

---

### [T12] ゲームクロック

`src/audio/clock.ts`:
- `songNow()`: (audioCtx.currentTime - audioStartTime) * 1000 (ms)
- `resetClock(audioCtx)`: audioStartTime をリセット
- `manualOffsetMs`: localStorageから読み込み
- `setManualOffset(ms)`: 変更+保存
- メトロノームの先読みスケジュールに manualOffsetMs/1000 を加算

---

### [T13] 音楽ファイルローダー

`src/audio/loader.ts`:
- `loadAudio(url: string, audioCtx: AudioContext): Promise<AudioBuffer | null>`
- fetch → arrayBuffer → decodeAudioData
- 失敗時: console.warn して null を返す（例外を外に投げない）

---

### [T14] BPMタイムライン

`src/audio/bpmTimeline.ts`:
- `BpmTimeline` クラス
- コンストラクタ: baseBpm, bpmChanges[]
- `beatToMs(beat)`: beat位置をmsに変換
- `msToBeat(ms)`: msをbeat位置に変換
- `bpmAt(beat)`: その時点のBPM
- `beatMsAt(beat)`: その時点の1beatのms

---

### [T40] TOMLチャートローダー

`src/chart/loader.ts`:
- `loadChart(url: string): Promise<Chart>`
- fetch → text → parse (smol-toml)
- 不足キーはデフォルト値補完: bpm_changes=[], segments=[], rings=[]

---

### [T41] 曲マニフェスト

`src/chart/manifest.ts`:
- `loadSongList(): Promise<SongEntry[]>`
- `/rhythm_game/songs.toml` をfetch→parse

---

### [T20] 波形エンジン

`src/game/waveEngine.ts`:
- `WaveEngine` クラス
- コンストラクタ: segments[], bpmTimeline
- `waveYAt(beat: number): number`
  - beat=0 のとき: TW_CENTER_Y - TW_AMP (上端)
  - 各セグメントを累積ビートで管理し、線形補間
  - direction="up" は下端→上端、"down" は上端→下端
  - 注意: 最初のセグメントは上端スタート
- `waveYAtMs(ms: number): number`

---

### [T21] カーソル

`src/game/cursor.ts`:
- `Cursor` クラス
- 初期Y: TW_CENTER_Y - TW_AMP
- `update(dt: number, upPressed: boolean, downPressed: boolean, beatMs: number, segmentBeats: number)`
- 速度: (2 * TW_AMP) / (segmentBeats * (beatMs / 1000)) px/sec（波形の現在セグメントの斜度と一致させる。segmentBeats=現在のセグメント拍数）
- clamp: [TW_CENTER_Y - TW_AMP, TW_CENTER_Y + TW_AMP]

---

### [T22] リングスポーナー

`src/game/ringSpawner.ts`:
- `RingSpawner` クラス
- `update(songTimeMs, rings: RingDef[], bpmTimeline, waveEngine): RingState[]`
- TW_LEAD_BEATS=3 拍前にspawn
- X描画位置: TW_JUDGE_X + (ring.hitTime - songTimeMs) / 1000 * TW_SCROLL

---

### [T23] ヒット判定

`src/game/hitJudge.ts`:
- `judgeHit(pressTimeMs, cursorY, rings: RingState[], currentBeatMs): HitJudgement | null`
- 最近傍リング（タイミング的に最も近い未解決リング）を選択
- タイミング誤差 < beatMs*0.4 AND Y距離 < 60: ヒット
- PERFECT条件: 誤差 < 50ms AND Y < 30px

---

### [T24] スコア管理

`src/game/score.ts`:
- `ScoreManager` クラス
- `recordHit(result: HitResult)`
- `recordTrace(dt: number, isOnWave: boolean)`
- `getStats()`: { score, combo, maxCombo, perfect, good, miss }
- `getRank()`: 'S'|'A'|'B'|'C'|'D'

---

### [T25] Canvasレンダラー

`src/game/renderer.ts`:
- `Renderer` クラス
- `render(ctx, { waveEngine, cursor, rings, score, songTimeMs, bpmTimeline })`
- 描画順: 背景 → 判定線 → 波形 → リング → カーソル → HUD
- 波形: アクセントカラー、線幅2.5px
- カーソル: コンボtier(0-3)で色変化 (accent→sub→positive→warning)
- リング: 半径64→14pxに縮小
- 背景: #0a0a0aのみ（装飾最小限）

---

### [T30] Reactアプリシェル

`src/App.tsx`:
- HashRouter + Routes
- / → SelectScreen
- /play/:songId → GameScreen
- /result → ResultScreen
- /editor → EditorScreen
- /calibration → CalibrationScreen

---

### [T60] 手動オフセット

ゲーム画面内: </> キーで±10ms。右下に `offset: +Xms` 表示。
clock.ts の setManualOffset() を呼ぶ。

---

### [T61] オートキャリブレーション

`src/screens/CalibrationScreen.tsx`:
- メトロノームを鳴らしながら Space×8 回
- 最初の2サンプルを破棄、残り6の平均から offset を設定
- progress: X/8 を表示
- ESC でキャンセル（変更を保存しない）

---

### [T62] キー効果音

K キーでトグル。localStorage('rhythmKeySound') に保存。
Space押下時に即座に 1320Hz sin波クリックを再生（ON時のみ）。

---

### [T32] ゲーム画面

`src/screens/GameScreen.tsx`:
- useRef で Canvas を参照
- useEffect でゲームループ (requestAnimationFrame) 起動
- ゲームループ: songNow() → update all engines → render
- ESC → navigate('/')
- R → resetGame()
- 曲終了（最後のリングのhitTime+2秒後）→ navigate('/result', { state: stats })

---

### [T33] リザルト画面

`src/screens/ResultScreen.tsx`:
- useLocation で stats を受け取る
- スコア: 0から実値へ1秒カウントアップ (requestAnimationFrame)
- ランク: 大きく中央表示
- PERFECT/GOOD/MISS 数
- ボタン: 「もう一回」（/play/:songId）「曲選択」（/）

---

### [T50] エディタ基盤

`src/screens/EditorScreen.tsx`:
- 左ペイン320px: 音楽制御・BPM設定
- 右ペイン flex: タイムライン表示
- ヘッダー: 「オーサリングツール」タイトル + 「/ に戻る」リンク

---

### [T42] ゲームとチャートの統合

GameScreen 内:
1. useParams でsongIdを取得
2. songs.tomlからSongEntryを検索
3. chartPathからChart読み込み
4. AudioBuffer読み込み（失敗してもゲーム続行）
5. BpmTimeline, WaveEngine, RingSpawner 初期化
6. ゲームループ開始

---

### [T31] 曲選択画面

`src/screens/SelectScreen.tsx`:
- loadSongList()で曲一覧取得
- カード一覧 (grid or flex)
- カード: タイトル・アーティスト・難易度バー
- ホバー: translateY(-2px) transform, transition 150ms
- クリック: navigate('/play/' + song.id)
- Lキー: navigate('/calibration')

---

### [T51] エディタ内オーディオ

左ペインに追加:
- URL入力フィールド（デフォルト: /rhythm_game/audio/08.Reply.flac）
- 再生/停止ボタン
- 現在位置表示 (秒 / beat)
- BPM入力フィールド

---

### [T52] リング録音

- 再生中にSpaceキーで現在beat位置をスタンプ
- スナップ: 最近傍0.25beatに丸める
- 右ペインにリスト表示 (beat: X.XX)
- 削除ボタン付き

---

### [T53] セグメントエディタ

右ペインに追加:
- セグメントリスト（上から順に）
- 各行: direction select (↑/↓) + beats input
- 追加ボタン、削除ボタン
- 変更するとリアルタイムで波形プレビュー（Canvas小）を更新

---

### [T54] BPMエディタ

左ペインに追加:
- 基本BPMフィールド
- BPM変更リスト（beat, newBpm）
- タップテンポボタン（4回タップで平均BPMを計算）

---

### [T55] TOMLエクスポート

「エクスポート」ボタン:
- 現在の状態をTOML文字列に変換
- Blob でダウンロード (reply.toml)

---

### [T56] エディタ内プレイテスト

「プレイテスト」ボタン:
- 現在の譜面をメモリ上でChartオブジェクト化
- GameScreenをモーダルorフルスクリーンで起動

---

### [T70] 曲選択画面ポリッシュ

- カードに border: 1px solid var(--border)
- 難易度: 星またはドット5個
- ローディング時スケルトン表示

---

### [T71] ゲーム画面ポリッシュ

- 判定テキスト (PERFECT!/GOOD/MISS) を判定線付近にフェードアウト表示
- コンボ数: 大きく表示、コンボ切れで揺れアニメーション
- ビートに合わせて背景が微妙にパルス（opacity 1→0.97→1、禁止: 色変化）

---

### [T72] リザルト画面ポリッシュ

- ランクを画面中央に大きく表示（font-size: 120px）
- スコアカウントアップ: ease-out
- 統計: PERFECT/GOOD/MISS を横並びカード

---

### [T73] エディタポリッシュ

- 右ペインのタイムラインにリング縦線を表示（X軸=beat位置）
- セグメントを色分け（up=accent, down=sub）

---

### [T74] 画面遷移アニメーション

CSS Transition のみ（ライブラリ不使用）:
- フェードイン: opacity 0→1, 200ms ease
- 各画面にクラス付与で制御

---

### [T80] E2E統合確認

手動で以下を確認:
1. `/` で曲一覧が表示される
2. 曲をクリックするとゲームが起動する
3. ゲームをプレイしてリザルト画面が出る
4. 「もう一回」で再プレイできる
5. コンソールに Uncaught エラーがない

---

### [T81] エラーハンドリング

- src/components/ErrorBoundary.tsx 作成
- App.tsx でラップ
- 音楽ロード失敗: 「音楽ファイルの読み込みに失敗しました（メトロノームのみで続行）」
- チャートロード失敗: 「譜面ファイルが見つかりません」
- songs.toml 失敗: 「曲リストの読み込みに失敗しました」

---

### [T90] ヒット判定のリング解決バグ修正

`src/game/hitJudge.ts`:
- 背景: `judgeHit()` はヒット判定（perfect/good/miss）を返すだけで、対象リングの `resolved` / `hit` を更新していない。このため
  1. 同じリングに Space 連打で複数回ヒットできてしまう
  2. `GameScreen.tsx` のウィンドウ超過ループ（`songTimeMs > ring.hitTime + windowMs` で `ring.resolved=true; recordHit('miss')`）が、既にヒット済みのリングにも後から MISS を再計上する
- 修正方針: `judgeHit()` 内で、ヒット対象となったリングを `resolved: true` に設定し、`result === 'miss'` でなければ `hit: true` にも設定する。
- `HitJudgement` は変更不要（`resolved` の副作用をリングオブジェクトに直接反映）。
- 既存仕様は維持: タイミング誤差 < beatMs*0.4 AND Y距離 < 60 でヒット。PERFECT: 誤差 < 50ms AND Y < 30px。

---

### [T91] 総合デバッグ

`src/game/hitJudge.ts` + `src/screens/GameScreen.tsx` + `src/screens/CalibrationScreen.tsx` + `src/screens/editor/WavePreview.tsx` + `src/audio/metronome.ts` + `src/screens/EditorScreen.tsx`:

**1. ヒット判定の対象リング選定改善**
- 現行バグ: タイミング誤差最小のリングを1つだけ選び（`err` 最小）、そのリングのY距離が60px以上なら即 `miss` を返す。このため、タイミングは近いがYが外れたリングに先に判定され、本来当たるべき（タイミングもYも合う）別リングに当てられない。
- 修正方針: タイミングウィンドウ内（誤差 < beatMs*0.4）の未解決リングの中から、**Y距離 < 60 を満たすもの**を優先して選ぶ。
  - Y距離 < 60 を満たすリングが複数ある場合 → タイミング誤差最小を採用
  - Y距離 < 60 を満たすリングが1つもない場合 → タイミング誤差最小のリングで `miss` を返す（従来挙動維持）
- PERFECT条件は維持: 誤差 < 50ms AND Y < 30px

**2. 曲終了判定を音楽の実長さ基準に**
- 現行: 最後のリングの hitTime + 2秒で終了判定（`lastHitTime`）。リングが曲より短いと曲が切れ、リングが曲より長いと終わらない。リング0個だと永遠に続く。
- 修正: 音楽ロード成功時は `buffer.duration * 1000` を終了時間の基準にし、`songTimeMs > buffer.duration*1000` で終了。音楽ロード失敗時は従来の「最後のリングのhitTime + 2秒」フォールバック。
- リング0個 + 音楽失敗の場合は「開始からの経過時間（例: 曲長が不明なら 60秒 で強制終了）」で終了できるようにする。

**3. メトロノームの latency 補正**
- 現行: `schedule()` の `when = nextBeatTime + offsetSeconds() + latency`。`osc.start(when)` は `when` ちょうどに鳴るため、`+latency` は音をさらに遅らせ、音楽（同ctxで再生）との相対同期が崩れる。
- 修正: `when = nextBeatTime + offsetSeconds()` にする（latency を足さない）。`latency` パラメータは削除し、呼び出し側（GameScreen / CalibrationScreen）の `latency = baseLatency + outputLatency` 計算も除去する。

**4. キャリブレーションのオフセットリセット**
- 現行: 計測開始時に既存 `manualOffsetMs` が効いたまま計測するため、計測値に既存オフセットが混ざる。
- 修正: Space 1回目（開始時）に `setManualOffset(0)` を呼んでから計測を始める。計測完了時に新オフセットを保存。

**5. WavePreview の BPM変更反映**
- 現行: `new BpmTimeline(bpm, [])` で BPM変更を無視。
- 修正: `WavePreview` に `bpmChanges` を渡し、`new BpmTimeline(bpm, bpmChanges)` にする。呼び出し側（EditorScreen）から `bpmChanges` を渡す。

**6. startGame の二重起動防止**
- 現行: `startGame()` は async（`await audioMgr.ensure()`）のため、await 中に Space連打で複数回呼ばれ、`resetClock` と音楽開始が複数回実行され得る。
- 修正: `startGame` 内で `startedRef.current` を最初に確認し、既に true なら即 return する二重起動ガードを追加。

**7. 回帰確認（挙동を壊さないこと）**
- 開始前（`startedRef.current === false`）にスコア・トレース・MISSが計上されないこと
- ヒット済みリングが後からMISS再計上されないこと（T90の成果を維持）
- メトロノームが連続して鳴り続けること（`schedule()` の `when` クランプと try/catch 継続）
- カーソル速度が波形の斜度（segmentBeats）と一致すること

---

### [T92] プレイ表示領域（波形上下幅）の固定拡張

`src/game/cursor.ts` + `src/game/waveEngine.ts` + `src/game/renderer.ts`:
- 振幅定数 `TW_AMP` を `80` から **`130`** に変更。
- 上下幅範囲が Y: 170〜430px（全高260px）になり、上部SCORE/COMBOや下部操作ヒントに侵食しない範囲でゲームプレイ領域を拡張。

---

### [T93] 譜面設定（TOML）拡張：縦横進み幅＆開始オフセット

`src/types.ts` + `src/chart/loader.ts` + `src/chart/serialize.ts` + `src/screens/editor/BpmEditor.tsx` (または ChartSettings) + `src/screens/GameScreen.tsx`:
- チャートTOMLおよび `Chart` 型に以下を追加:
  - `audio_offset`: number (ms)
  - `scroll_speed`: number (px/sec)
  - `amplitude`: number (px)
- エディタの「BPM設定」ペイン（またはチャート設定ペイン）でこれらのパラメータを編集可能にし、TOMLエクスポートに含める。ゲーム画面や波形プレビューでも反映。

---

### [T94] セグメント方向「とどまる (stay)」追加 ＆ リアルタイムセグメント録音

`src/types.ts` + `src/game/waveEngine.ts` + `src/screens/editor/SegmentEditor.tsx` + `src/screens/EditorScreen.tsx`:
- `Segment.direction` に `'stay'` （水平にとどまる）を追加。
- `WaveEngine` で `'stay'` セグメントのY座標を直前のY位置のまま固定するロジックを実装。
- エディタ再生中にキー入力（矢印キー等）でリアルタイムにセグメント（方向・拍数）をスタンプ録音できる機能を追加。

---

### [T95] ホールドリング（長押しノーツ）の追加

`src/types.ts` + `src/game/ringSpawner.ts` + `src/game/hitJudge.ts` + `src/game/renderer.ts` + `src/screens/EditorScreen.tsx`:
- リング定義 (`RingDef`, `RingState`) に `duration?: number` と `type?: 'single' | 'hold'` を追加。
- ゲーム画面でホールドリングの長押しトレース判定（キー押し続け中の継続判定）およびテール描画を実装。
- エディタで単発/ホールドの切り替えおよび長さ指定を可能にする。

---

### [T96] オーサリングツール（エディタ）のUI/UX刷新

`src/screens/EditorScreen.tsx` + `src/screens/editor/WavePreview.tsx` + `src/screens/editor/SegmentEditor.tsx`:
- **プレビュー拡大**: `WavePreview` の縦幅を大幅に拡大し、グリッド・判定線・ノーツを高視認化。
- **デフォルト折りたたみ**: 右ペインの「リング一覧」「セグメント一覧」を `<details>` アコーディオン化し、デフォルトで折りたたむ。
- **直感編集**: タイムライン/プレビュー上で直接クリックやドラッグによるノーツ追加・選択・移動・削除をサポート。

---

### [T97] オーサリングツール総合使い勝手（エディタとして十分使えるかの測定）

特定機能（直感編集など）に限定せず、**チャートエディタとしての一連の作成ワークフロー全体**が十分に使えるかを測定・改善する。

`src/screens/EditorScreen.tsx` 他エディタ関連ファイルを総合的に評価し、以下の全体フローが破綻なく・迷いなく・ストレスなく完了できるよう不足を補う:
- 音楽ファイルの読込と再生・シーク
- BPM（基本・変更）の設定
- リング・セグメントの配置・編集・削除
- 波形プレビューでの即時確認
- TOMLエクスポート（正規フォーマットで出力・再読込可能）
- プレイテストによる内容確認

測定観点（Gate C で評価）:
- **完結性**: 上記フローがすべて実行可能で、行き詰まり（デッドエンド）がないか
- **一貫性**: 操作・表示・用語が統一され、説明なしで直感に操作できるか
- **フィードバック**: 各操作に対して即時かつ明確な視覚的応答があるか
- **堅牢性**: 空状態・異常入力でも壊れず、エラーが分かりやすいか
- ゲーミングRGB・過剰グロー禁止（Linear/Vercel風ミニマル）。単なる機能追加ではなく「エディタとして使えるか」の総量を問う。

---

### [T99] オーディオオフセットの音楽制御ペイン移動＋再生反映

`src/screens/EditorScreen.tsx` + `src/screens/editor/BpmEditor.tsx`:
- `BpmEditor.tsx` からオーディオオフセット入力（`#audio-offset`）を削除し、左ペインの音楽制御セクション（`#music-control`）内に移動。
- `EditorScreen` の `audioOffset` 状態を `playFrom(ms)` 内で再生オフセットとして確実に適用（デコード済バッファの `start(0, offsetSec)` 等）。
- 完了条件: 音楽制御ペイン内に `#audio-offset` が存在し、`BpmEditor` 側には存在しないこと（`toHaveCount(0)`）。オフセット値を変更して再生し、再生位置がオフセット分だけずれることを自動テストで確認。

---

### [T100] 録音時ホールドリング反映

`src/screens/EditorScreen.tsx` + `src/game/ringSpawner.ts`:
- 録音モードで Space を押し続けている間、hold 型リング（`type: 'hold'`, `duration` = 押下時間）を生成し、停止/コミット時にリングリストへ反映。
- 完了条件: 録音後に `ring-type-select` が `hold` のリングが存在し、内部状態（`type === 'hold'`, `duration > 0.3`）を自動テストで確認。

---

### [T101] 録音時クオンタイズ（snap吸着）＋分解能UI

`src/screens/EditorScreen.tsx` + `segmentize()`:
- 録音中に上下キーで記録した軌跡を `segmentize(traj, snap, amplitude)` でセグメント化する際、各セグメントの `beats` を選択した snap 解像度（0.125 / 0.25 / 0.5 / 1）の**整数倍**に丸める。
- 左ペインに「クオンタイズ / スナップ」セクション（`#snap`）と分解能ドロップダウン（1/4・1/2 等）を追加し、内部状態 `snap` に反映。
- 完了条件: 録音して得られたセグメント配列の各 `beats` が `snap` の整数倍であることを自動テストで検証（本タスクの核心要求）。

---

### [T102] レガシー再生中セグメントスタンプ完全削除

`src/screens/EditorScreen.tsx`:
- `onKeyDown` において `mode !== 'record'`（再生中等）の場合、上下キー・W/S によるセグメント追加/スタンプ処理を完全に除去（record モード時のみ軌跡記録）。
- 完了条件: 再生モードで ArrowUp/ArrowDown/W/S を押してもセグメント配列の件数が変化しないことを自動テストで確認。

---

### [T103] レガシー再生中リングスタンプ完全削除

`src/screens/EditorScreen.tsx`:
- `onKeyDown` / `onKeyUp` において、`mode !== 'record'`（再生モード中等）の場合、Space キー押下によるリング（単発/ホールド）の追加・スタンプ処理を完全に無効化。
- リングのキーボードスタンプは、`mode === 'record'`（録音モード）中のみ許可する。
- 完了条件: 再生モード（playモード）で再生中に Space キーを押してもリング配列（`rings`）の件数・内容が変化しないこと、および録音モード（recordモード）では Space キーで正常にリングが追加されることを自動テスト（正負両コントロール）で確認。

---

### [T104] 波形プレビュー描画の頂点レンダリング化

`src/screens/editor/WavePreview.tsx`:
- **固定ステップサンプリングの廃止**: `for (let s = 0; s <= subSteps; s++)` のような等間隔サンプリングを廃止。
- **頂点直接描画**: 各セグメントの開始ビート・終了ビートおよび方向転換点（頂点）を直接 `lineTo` で結んで描画。ズーム倍率やスクロール位置に関わらず、常に鋭く正確な折れ線として描画する。
- **セグメント個別区間描画**: セグメント描画ループ内で画面全体の全波形を多重描画していたバグを解消し、各セグメントの区間 `[currentBeat, segEnd]` のみを担当色（`up`=accent, `down`=sub, `stay`=warning）で描画。
- 完了条件: セグメントが存在する状態で、ズーム（viewBeats変更）時にも波形の曲がり角が鈍角・丸まらずに正確な頂点として描画されることを自動テストで確認。

---

### [T105] 録音クオンタイズのキー離し（リリース）位置吸着改善

`src/chart/quantize.ts` + `src/screens/EditorScreen.tsx`:
- **リリース位置吸着の数学的定義**:
  - キーを押して離した拍を $b_{\text{rel}}$、スナップ分解能を $s$（0.125 / 0.25 / 0.5 / 1）としたとき、移動セグメント（`up`/`down`）の終点拍は $b_{\text{end}} = \text{round}(b_{\text{rel}} / s) \times s$ とする。
  - 例: $s = 0.5$ のとき、
    - $b_{\text{rel}} = 1.2$ 拍で離した場合 ➔ $b_{\text{end}} = 1.0$ 拍（$1.0 \sim 1.2$ の微小移動は最近傍の 1.0 に吸着され、1.0 で水平 stay に移行）。
    - $b_{\text{rel}} = 1.3$ 拍で離した場合 ➔ $b_{\text{end}} = 1.5$ 拍（$1.5$ 拍まで坂道が綺麗に延長され、1.5 で水平 stay に移行）。
  - **オーバーシュートの完全防止**: $b_{\text{end}}$ を超えて次のグリッドまで坂道が伸びる（余分な up/down が生成される）現象を完全に解消。
- **キー操作に応じたセグメント生成**: 押下開始から離すまでの区間を正確に $s$ の整数倍の `up`/`down` セグメント化し、離している区間は $s$ の整数倍の `stay` としてスナップグリッド境界に整列。
- **完了条件（オフグリッド検証必須）**:
  1. グリッド境界ピッタリだけでなく、**必ず端数タイミング（例: snap=0.5 で 1.2拍や1.3拍など）でキーを離すテスト** を含めること。
  2. 生成されたすべてのセグメントの `beats` が設定した `snap` の整数倍であること。
  3. 移動セグメントの終点が $\text{round}(b_{\text{rel}} / s) \times s$ と一致し、それ以降に不要な坂道が伸びていないことを自動テストで検証。

---

### [T106] ローカル音声ファイル読込機能（File Input & Drag-and-Drop）

`src/audio/loader.ts` + `src/screens/EditorScreen.tsx`:
- **ローカルファイルデコード**: `loadAudioFromFile(file: File, audioCtx: AudioContext): Promise<AudioBuffer | null>` を追加。`file.arrayBuffer()` を `audioCtx.decodeAudioData()` でブラウザローカルだけでデコード。
- **UI統合**:
  - エディタ画面の左ペインに「ファイル選択（`<input type="file" accept="audio/*" data-testid="audio-file-input">`）」ボタンを追加。
  - エディタ画面全体または専用エリアへのドラッグ＆ドロップ（`dragover`/`drop` イベント）による音声ファイル読み込みに対応。
  - ファイル読み込み成功時、ファイル名（拡張子除く）を自動で楽曲タイトル（`title`）に反映。
- 完了条件: Playwright で `<input type="file">` に音声ファイルを `setInputFiles`（またはドロップ）した際、エラーなくオーディオバッファがロードされ、再生・タイムラインが利用可能になることを自動テストで検証。

---

### [T107] 波形上下表示領域拡張

`src/screens/editor/WavePreview.tsx`:
- canvas の縦マップを広げ、波形の上下表示領域を拡張（SCORE/COMBO/操作ヒントに侵食しない範囲）。`amplitude` 反映を維持。
- 完了条件: canvas の非透明ピクセルの縦幅（`waveHeight`）が canvas 高の 0.3 倍以上であること、かつ上下端が表示領域内にあることを自動テストで確認。

---

### [T108] Canvasホイールズームでページスクロール防止

`src/screens/editor/WavePreview.tsx`:
- ホイールイベントハンドラ（`onWheel`）で `e.preventDefault()` を確実に呼び、ページがスクロールしないようにする（非 passive リスナ）。
- 完了条件: canvas 上でホイール操作した際、ページの `window.scrollY` が変化しないことを自動テストで確認。

---

### [T109] 録音上書き範囲の限定

`src/screens/EditorScreen.tsx` (`finishRecording`):
- 録音停止時のコミットで、開始 beat（`startBeat`）〜終了 beat（`endBeat`）の範囲のみを上書きし、それ以降のセグメントを維持。
- 完了条件: 録音前に存在した `endBeat` 以降のセグメントが録音後も件数・内容ともに維持されていることを自動テストで確認。

---

### [T110] ホーム画面ローカル譜面・音源ドラッグ＆ドロップ（文化祭GDriveワークフロー対応）

`src/screens/SelectScreen.tsx` + `src/App.tsx` + `src/screens/GameScreen.tsx` + `src/audio/loader.ts` + `src/chart/loader.ts` + `src/chart/serialize.ts`:
- **ファイル名のみ統一**: TOML内 `audio` はファイル名のみ（例 `08.Reply.flac`）。`loader.ts` は旧フルパスを `basename` 抽出で互換吸収、`serialize.ts` は常にbasenameのみ出力。
- **ホームUI**: `SelectScreen` に譜面TOML (`input[data-testid="home-chart-input"] accept=".toml"`) と音源 (`input[data-testid="home-audio-input"] accept="audio/*"`) の個別ファイル選択 + 画面全体 `dropzone[data-testid="home-dropzone"]` を追加。`DataTransfer.files` で拡張子振り分け。
- **紐付け**: TOMLの `audio` basename と音源 `file.name` の完全一致で紐付け。順不同・片方のみでもメトロノームプレイ可。揃ったら「この譜面でプレイ」ボタンを活性化。
- **共有キャッシュ**: `src/audio/AudioCache.ts` / `src/chart/cache.ts`（または AudioManager 内 `Map<basename, AudioBuffer>`）で `chart` / `buffer` を共有。`EditorScreen` と `GameScreen` で再利用。
- **プレイ遷移**: `navigate('/play/custom', {state:{chart, buffer}})` で in-memory 受け渡し。`GameScreen` は `location.state` があれば `loadSongList/loadChart/loadAudio` をスキップ。
- 完了条件: Playwrightで両ファイルに `setInputFiles` → ボタン活性 → クリックでゲームcanvas表示 → コンソールエラー0。順序逆パターンも検証。

---

### [T111] プレイテスト音源共有の修正

`src/screens/EditorScreen.tsx` + `src/screens/GameScreen.tsx` + `src/audio/AudioCache.ts`:
- `EditorScreen` の `playtest` stateを `{chart: Chart, buffer: AudioBuffer|null}` 直渡しに変更。`playFrom` の `buffer` を保持。
- `GameScreen` は `playtestBuffer` があれば `loadAudio(chart.audio)` の再fetchをスキップ。ローカルFile時 `url=file.name` でfetch不能になるメトロノームのみ問題を解消。
- TOML `audio` はbasenameのみ（T110で統一）。
- 完了条件: エディタでローカル音源読込→再生→プレイテストで `AudioBuffer` が再生され、メトロノームのみにならないことを自動テストで検証。

---

### [T112] 振幅の正規化（0.0〜1.0）化

`src/types.ts` + `src/game/waveEngine.ts` + `src/game/cursor.ts` + `src/screens/editor/BpmEditor.tsx` + `src/screens/editor/WavePreview.tsx` + `src/chart/loader.ts` + `src/chart/serialize.ts`:
- **正規化**: `Chart.amplitude` の単位を `px` から正規化 `0.0〜1.0` に変更（`1.0=上端 / -1.0=下端 / 0.0=中央`）。`NORM_TO_PX=130` は描画層のみの定数。
- **エンジン**: `waveEngine.ts` は正規化で `moveNorm = 2 * normAmp * (beats / WAVELENGTH_BEATS)` を計算し最後に `* NORM_TO_PX` で `px` に変換。`cursor.ts` は `speedNorm = 2*normAmp/4` → `speedPx = speedNorm * NORM_TO_PX / beatSec`。
- **エディタUI**: `BpmEditor.tsx` の `#amplitude` を `0.1〜1.0 step 0.1` のスライダー/数値に。ラベル「振幅 (正規化 0.0-1.0)」。
- **マイグレーション**: `loader.ts` は旧px値（`>1.5`）を `amplitude/130` に変換。`serialize.ts` は正規化のみ出力。
- **縦目盛りは追加しない**。BPMが変わっても拍基準のキリの良さが崩れないこと。
- 完了条件: 同一Chart(normAmp=1.0)で `BPM 120` と `180` の `waveYAt(2)` の正規化値が一致すること、旧px値 `130` が `1.0` に読み込まれることを自動テストで検証。

---

### [T113] replyハードコード依存排除

`src/screens/EditorScreen.tsx` + `tests/*.spec.ts`:
- `EditorScreen` の `link.download='reply.toml'` を `slugify(title) || 'untitled'` で `${slug}.toml` に汎用化。初期 `title=''` `url=''` に変更。ヒント文も汎用化。
- `tests` 5件の `suggestedFilename()=reply.toml` 固定期待を `toMatch(/\.toml$/)` に緩和。
- TOML内 `audio` のbasename統一はT110で対応。
- 完了条件: 空タイトルで `untitled.toml`、タイトル「My Song」で `my-song.toml` がダウンロードされることを自動テストで検証。

---

### [T114] スタート位置指定

`src/types.ts` + `src/game/waveEngine.ts` + `src/game/cursor.ts` + `src/chart/loader.ts` + `src/chart/serialize.ts` + `src/screens/EditorScreen.tsx` + `src/screens/GameScreen.tsx`:
- `Chart` に `start_position: number` (-1.0〜1.0, 0.0=中央, 1.0=上端, -1.0=下端) を追加。TOMLでは `start_position = 0.0`。
- `WaveEngine` / `Cursor` は初期Yを `TW_CENTER_Y - start_position * NORM_TO_PX` で開始（T112の正規化と同スケール）。旧上端固定を廃止。
- `loader.ts` は未定義時 `0.0` にマイグレーション（旧チャートは中央にリセット）。`serialize.ts` は正規化で出力。
- エディタの譜面情報ペインに `-1.0〜1.0 step 0.1` スライダー (`#start-position`) を追加。
- 完了条件: `start_position=0.0` で `waveYAt(0)==CENTER`, `1.0` で上端, `-1.0` で下端になること、旧チャート読み込みで中央になることを自動テストで検証。

---

### [T115] エディタ自動スクロール追従 ＆ Space再生・R録画ショートカット

`src/screens/EditorScreen.tsx` + `src/screens/editor/WavePreview.tsx`:
- **自動スクロール**: プレビュー再生中、現在の拍位置がビュー右端に近づいたときに自動で `viewStartBeat` を追従スクロール。
- **ショートカット**: `Space`（再生/停止トグル）、ライブラリ内グローバルでの `R`（録画開始/停止トグル）。

---

### [T116] Blender風3モード切替式エディタ ([V] 頂点 / [E] 辺 / [R] リング)

`src/screens/EditorScreen.tsx` + `src/screens/editor/WavePreview.tsx`:
- **3つの独立モード**:
  1. `Vertex` (`V`): 頂点の直接ドラッグによる位置・高さ微調整
  2. `Edge` (`E`): 辺（セグメント）選択による一括編集・プロパティ変更
  3. `Ring` (`R`): リング配置専用の独立レイヤー（クリック/ドラッグで追加・削除）
- **UI & ショートカット**: 上部に切替トグル配置、`V`/`E`/`R` キーで即時トグル。

---

### [T117] メトロノーム ON/OFF スイッチ

`src/screens/EditorScreen.tsx`:
- 左ペインの音楽制御セクションに `<input type="checkbox" data-testid="metronome-switch" defaultChecked /> メトロノーム音` を追加し、再生ループ中のスケジューラへ動的連携。

---

### [T118] アコーディオン ⇄ 波形プレビューの相互ハイライト連동

`src/screens/EditorScreen.tsx` + `SegmentEditor.tsx` + `WavePreview.tsx`:
- 右ペインの各行ホバー/選択時にプレビュー上の対象要素を強調表示し、プレビュー上の要素クリック時に対応アコーディオン項目が展開・フォーカスされる相互連動。

---

### [T119] 通常プレイ時の難易度緩和アシスト「波の磁力（ウェーブ・アトラクション）」

`src/game/cursor.ts` + `src/screens/GameScreen.tsx`:
- 通常プレイ時、1拍境界を通過する瞬間にカーソル位置が波の目標位置へ向かって自動吸着（プル）されるアシスト機能（初心者・展示向け難易度調整）。

---

### [T120] ホーム画面のカスタム譜面インポート「追加」機能

`src/screens/SelectScreen.tsx`:
- **UI変更**: インポートエリアのボタン文言を「この譜面でプレイ」から **「追加」** に変更。
- **曲一覧への動的登録**: TOMLと音声ファイルが揃って「追加」ボタンが押されたとき、新しい `SongEntry`（例: id=`custom-${Date.now()}`、title=TOMLのタイトル、artist=アーティスト名など）を生成し、曲一覧（`songs` 状態）の先頭または末尾に追加する。
- **キャッシュとプレイ連携**: `ChartCache` と `AudioCache` に対応する Chart と AudioBuffer を保持させ、追加されたカスタム曲カードをクリックした際に通常の楽曲と同様にゲーム画面へスムーズに遷移してプレイできるようにする。
- 完了条件: カスタム譜面と音声を読み込んで「追加」を押すと曲一覧カードに新しいカードが出現し、それをクリックしてエラーなくゲームを開始・プレイできることを検証。

---

### [T121] スクロール速度 (`scroll_speed`) のゲームプレイ反映修正

`src/game/ringSpawner.ts` + `src/screens/GameScreen.tsx`:
- **動的スクロール速度適用**: `RingSpawner` 内等でハードコードされていた定数 `TW_SCROLL` を廃止し、チャートの `scroll_speed` を動的に反映させてノーツのスクロール速度を正しく制御・描画する。

---

### [T122] 振幅 (`amplitude`) 1以上の設定対応とローダー閾値修正

`src/screens/editor/BpmEditor.tsx` + `src/chart/loader.ts`:
- **振幅入力制限撤廃**: `BpmEditor` の振幅入力上限（`max={1.0}`）を撤廃し、1以上（例: `max={5.0}`等）を設定可能にする。
- **ローダー閾値修正**: `chart/loader.ts` の旧ピクセル値判定閾値を `>1.5` から `>10` に修正し、1以上の正規化振幅が誤ってピクセル値として除算されないようにする。

---

### [T123] 波形振幅(amplitude)の定義変更と物理固定

`src/game/waveEngine.ts` + `src/game/cursor.ts` + `src/chart/loader.ts` + `src/screens/editor/BpmEditor.tsx`:
- **定義変更**: `amplitude` を「座標スケーリング(px)」から「速度係数(時間倍率の逆数)」へ再定義する。
  - 座標: 上下幅は `TW_AMP` で固定する。
  - 速度: `amplitude` は移動に必要な拍数にかかる係数とする（例：`amplitude=1`なら1拍で全幅移動、`amplitude=2`なら0.5拍で全幅移動）。
- **実装**:
  - `WaveEngine.buildPoints`: `waveTop`/`waveBottom` を `TW_AMP` ベースに修正。
  - `WaveEngine`/`Cursor`: 移動拍数計算に `amplitude` を使用するように修正。
- **完了条件**: 振幅設定を変更しても波の上下幅が変化せず、プレイヤーの移動速度（斜度）のみが変化することを検証。
---

### [T124] 振幅(amplitude)の物理的な固定と速度係数化の反映修正

`src/game/waveEngine.ts`:
- 波形描画高さ（waveTop/waveBottom）計算をTW_AMP（固定）基準に戻す。
- move距離計算を修正し、amplitudeが高いほど速度が上がる（＝到達時間が短くなる）ようにする。
- 完了条件: 振幅設定を変更しても描画される波形の高さ（上限・下限）が不変であり、かつ移動速度のみが変化することを検証。

---

### [T125] 振幅(amplitude)連動型の波形編集ロジック修正

`src/screens/EditorScreen.tsx`:
- 頂点/辺編集時のマウスドラッグによる座標算出ロジックを、マウス位置直接指定から `WaveEngine` を介した「振幅(amplitude)に基づく速度計算」へ変更する。
- 頂点ドラッグ時、新しいビート位置に応じた Y 座標を `WaveEngine` の逆算ロジックで求め、振幅と矛盾しないようにする。
- 定数 (`TW_AMP` 等) を `WaveEngine` からインポートするように統一する。
- 完了条件: 振幅(amplitude)を変更した後でも、頂点/辺のドラッグ操作が波形の速度係数と矛盾せず、かつスムーズに連動して編集できることを検証。

---

### [T126] 録音時のセグメント長クオンタイズの物理整合性修正

`src/chart/quantize.ts`:
- `segmentize` 関数において、セグメントの長さを録音時の「rawな拍数」から算出するのではなく、`amplitude`（速度係数）に基づく「物理的に正しい拍数」へ強制的にスナップ（丸め）するようにロジックを修正。
- 録音された手の動きが物理速度と矛盾する場合、最も近い「設定速度で全幅移動できる拍数」を計算し、それをセグメントの長さとして採用する。
- 完了条件: どのような速度で録音を行っても、生成されるセグメントの長さ（beats）が、`amplitude` と `snap` 設定に基づいた物理的に整合性のある拍数に固定されることを自動テストで検証。

---

### [T127] 速度係数(amplitude)の規約全体の再統一と波形状の修復

**バグ**: 「速度係数に基づいた波形にならない」バグ。`amplitude` の速度係数としての解釈が `waveEngine.ts` の `buildPoints` だけ他と逆転し、カーソルが波形に追従しない。

**共通規約（全箇所で統一）**:
> `amplitude`（速度係数）: 全幅（`2*TW_AMP`）移動に必要な拍数の逆数。1拍あたりの移動量 = `2*TW_AMP*amplitude` px。
> `amplitude=1` → 1拍で全幅移動、`amplitude=2` → 0.5拍で全幅移動。**高いほど急峻（速い）**。
> 物理上下幅は `TW_AMP=130` で固定（T123/T124の成果を維持。振幅変更で高さは不変、速度のみ変化）。

**現状の不整合（調査結果）**:
- ✅ `src/game/cursor.ts:23` `speed = 2*TW_AMP*amplitude / (beatMs/1000)` → 高いほど速い
- ✅ `src/chart/quantize.ts:44` `basePhysical = 1/amplitude`（全幅移動の拍数）→ 高いほど速い
- ❌ `src/game/waveEngine.ts:71` `move = (2*TW_AMP)/amplitude` → **高いほど遅い（逆転）**

**修正方針**:
- `src/game/waveEngine.ts`: `buildPoints` のセグメント移動量を `2*TW_AMP/amplitude` から `2*TW_AMP*amplitude*beats`（`[waveTop, waveBottom]` にクランプ）へ変更し、cursor/quantize と同一規約に。amplitude=1で1拍全幅、2で0.5拍全幅。
- `src/game/cursor.ts`: 式は正しいので変更不要。ただしコメントを正確な規約（高いほど速い）に明文化。
- `src/chart/quantize.ts`: 既に正しいが、同一規約であることをコメントで明文化。
- `src/screens/editor/WavePreview.tsx`: 頂点ドラッグ（T125）が新移動量（`2*TW_AMP*amplitude*beats`）で波形頂点Yを再現・クランプするよう整合。`waveYAt` を介した逆算を維持。
- `src/screens/EditorScreen.tsx`: 録音カーソル初期Y（`engine.waveYAt`）と `truncateSegmentsTo` が新波形に追従することを確認（式は `WaveEngine` 経由なのでそのまま整合）。
- ゲーム内: `GameScreen.tsx:361` のトレース判定 `|cursor.y - wave.waveYAtMs()| < TW_TOLERANCE` が、新波形とカーソルの一致により成立することを確認。

**完了条件（自動テストで検証。速度係数・録音操作で複雑な数字を必須とする）**:
1. **波形頂点Y = cursor速度式で算出されること**（複雑な振幅で）:
   - `amplitude` を複雑な端数（例: `0.7`, `1.3`, `2.7`, `3.4` など）へ設定。
   - 各振幅で `waveEngine.waveYAt(beat)` の頂点Yが `TW_CENTER_Y ± 2*TW_AMP*amplitude*beats`（clamp）と一致する（遅い側に倒れない）こと。
2. **cursor と waveEngine が同一規約で一致すること**:
   - 同じ振幅・同じ beatMs で、cursor の1拍あたり移動量と waveEngine のセグメント移動量が `2*TW_AMP*amplitude` で一致。
   - オフグリッド位相（例: 0.37拍, 1.23拍）でも波頂点が正しいこと（オフグリッド検証原則）。
3. **録音操作の複雑な入力（end-to-end）**:
   - 例: amplitude=1.3, snap=0.5 の組み合わせで、エディタ録音操作（↑↓ を端数タイミングで押す）→ 録音カーソル軌跡と波形プレビューが同一規約で重なる。
4. **回帰**: `amplitude` を変えても波の上下幅（`TW_AMP=130`）が不変（T123/T124維持）＋ 移動速度のみ変化。

**テスト設計上の注意**: T126が「既に実装済みで全テスト合格→誤判定」された反省から、T127のテストは窓口関数単体呼び出しではなく、`WaveEngine`(waveYAt/getPoints) と `Cursor`(update) の**数値整合**を複雑な振幅値で直接検証する構造にする。

---

### [T128] 波形のクリップ時傾斜崩壊の修正

**バグ**: 「速度係数より緩やか（遅い）になる」残存バグ。T127で `buildPoints` の移動量式（`2*TW_AMP*amplitude*beats`、上下幅クランプ）は正しくなったが、`WaveEngine.waveYAt()` が**クランプ済み端点の2点間を線形補間**するため、区間が上下幅にクランプされたセグメントで「実変位 ÷ フル拍数」の傾斜となり、速度係数 `2*TW_AMP*amplitude` より**緩やか**になってしまう。

**実測例**（amp=1.0, セグメント `down beats=3`, 中央スタート）:
- カーソル速度 = `2*130*1.0` = 260px/拍 → beat 0.5 で下端(130px)到達。
- 現行 `waveYAt` = 43.3px/拍 → beat 3 まで下端に届かない。
- つまりクランプは変位を減らす方向にしか働かず、**「速くなる事は無く、遅い・緩やか側のみ発生」**。ゲーム内トレース判定 `|cursor.y - wave.waveYAtMs()| < TW_TOLERANCE` や波形プレビューが不一致になる。

**共通規約（T127 と同一）**:
> `amplitude`（速度係数）: 全幅（`2*TW_AMP`）移動に必要な拍数の逆数。1拍あたりの移動量 = `2*TW_AMP*amplitude` px。
> `amplitude=1` → 1拍で全幅移動、`amplitude=2` → 0.5拍で全幅移動。**高いほど急峻（速い）**。
> 物理上下幅は `TW_AMP=130` で固定。

**修正方針**:
1. `src/game/waveEngine.ts`:
   - `WavePoint` に**セグメント開始点の1拍あたり変位 `dY`** を追加（`up` = `-2*TW_AMP*amplitude`, `down` = `+2*TW_AMP*amplitude`, `stay` = `0`）。
   - `buildPoints` は各セグメントの開始点に `dY` を記録し、端点 `y`（表示・エディタ用）は従来通りクランプ済み値を保持。
   - `waveYAt(beat)` は区間 `[p0.beat, p1.beat]` 内で `y = clamp(p0.y + p0.dY * (beat - p0.beat), waveTop, waveBottom)` と**補間中にもクランプ**し、急峻な傾斜（climb）と境界到達後の水平 stay を表現。カーソル速度式と厳密に一致させる。
   - **`getPoints()` は `{beat, y}` 構造と長さ（= セグメント数 + 1）を不変に保つ**こと（エディタの「1点 = 1セグメント」対応を維持、T116/V・E・R モードへの干渉禁止）。
2. `src/screens/editor/WavePreview.tsx`（T128自体の作業。エディタ表示をゲーム波形と一致させる）:
   - セグメント描画ループを単一 `lineTo` から `waveYAt` サンプリングの**ポリライン**（climb → stay）へ変更し、急速なコーナーを正しく描画。
   - `nearestEdgeIndex` も同一のクランプポリラインで判定し、辺選択が表示と一致するようにする。
   - 頂点ハンドル・ドラッグ（T125）は `getPoints()` の不変性によりそのまま維持。

**完了条件（自動テスト。オフグリッド検証原則に従い端数タイミング必須）**:
1. **クランプ区間の途中拍で Y = cursor移動量**:
   - `amplitude` を複雑な端数（`0.5`, `0.7`, `1.0`, `1.3`, `2.7` など）に設定。
   - 例: amp=1.0, `[{down, beats:3}]`, startPosition=0 で、beat `0.25`, `0.5`, `1.0`, `1.5`, `2.0` の `waveYAt` が `clamp(CENTER + 2*TW_AMP*amp*beat, top, bottom)` と一致すること（現行 43.3px/拍 の遅さが消える）。
   - 端数タイミング（例: `0.37`, `1.23` 拍）でも同一規約で一致（オフグリッド検証原則）。
2. **cursor と waveEngine の数値整合**:
   - 同じ amp / beatMs で、cursor の1拍あたり移動量と `waveYAt` の区間傾斜が `2*TW_AMP*amplitude` で一致し、遅い側に倒れないこと。
3. **startPosition ≠ 0 / stay / 方向反転・多セグメント**:
   - 中央以外から開始、`stay` 混在、up↔down 反転の複数セグメントで、区間内傾斜が物理速度と一致し、境界での水平 stay が正しいこと。
4. **回帰**:
   - `getPoints()` の長さが `セグメント数 + 1` のまま（エディタ 1:1 保守）。
   - 既存 T127 不変量（端点 `min(TW_AMP, 2*TW_AMP*amp*beats)`、上下幅 `TW_AMP=130` 不変、`segmentize`）が回帰しないこと。
    - `WaveEngine`(waveYAt/getPoints) と `Cursor`(update) の数値整合を**複雑な振幅値で直接**比較する構造にする（T127のテスト設計上の注意を踏襲）。

---

### [T129] 録音モードのセグメント長クオンタイズ修正（snap解像度優先）

**バグ（2症状）**: T128 で速度係数には従えるようになったが、録音モードで以下の2つの回帰が発生。
1. **スナップ解像度が無視され、必ず全幅移動のみ**になる。
2. **波形上書き機能が波形加算（ずれ/隙間）に見える**。

**根本原因**: `src/chart/quantize.ts` の `segmentize()` に T126 が導入した `physicalSnap = quantizeBeat(1/amplitude, snap)` が、`amplitude>=1 かつ snap<=1` で常に `1.0` になり、全セグメント長を強制的に「全幅移動に必要な拍数（1/amplitude）」へ丸めるため。
- 実測例: 0.30拍の短押し（amp=1）が snap=0.125/0.25/0.5/1 の**全て**で `beats:1`（全幅）になる。
- 録音範囲 `[startBeat, endBeat)`（例: 1.25拍）に対し `newSegs`（例: 1.0拍）が短くなり、`keptAfter` との間に隙間が生じて「加算/ずれ」に見える。

**共通規約**: セグメント長は**ユーザーが選択した snap 解像度の整数倍**（最小 1 snap）で決める。`1/amplitude` による強制は**廃止**する。T128 の dY 補間モデルにより、端数セグメント（例 0.25拍）も部分移動として正しく描画されるため物理整合性は保たれる（高振幅・急峻でも矛盾しない）。

**修正内容**: `src/chart/quantize.ts` の `segmentize()`。
- 各ランの長さを `quantizeBeat(rawBeats, snap)`（snap 基準）へ揃える。`beats < snap` なら最小 `snap` にクランプ（0/自由長セグメント防止）。`1/amplitude` の `physicalSnap` 計算とそれによる再クオンタイズを除去。
- 方向判定（up/down/stay）用の `threshold` と `basePhysical` は不要になった部分を整理。`finishRecording`（EditorScreen.tsx）の `keptBefore/newSegs/keptAfter` 合成は既に正しいため**変更不要**。

**完了条件（オフグリッド検証原則に従い端数タイミング必須）**:
1. snap別（0.125/0.25/0.5/1）で、**端数タイミングの短押し**（例: 0.30拍, amp=1）が `snap` の整数倍のセグメント（0.25/0.25/0.5/1）を生成し、各セグメントの `beats` が `snap` の整数倍であること。
2. **1/amplitude でない**ことを検証（例: snap=0.25, amp=1, 短押し0.30拍 → `beats=0.25` であり `1.0` でない）。
3. 録音範囲 `[startBeat, endBeat)` と `newSegs` の総ビートがグリッド整列で一致し、`finishRecording` 合成（keptBefore + newSegs + keptAfter）が連続した上書き波形になること（隙間・重複なし）。
4. 既存の snap 整合性（`dynamic.test.ts` の本セクション、`t101.spec.ts` の「beats が snap の整数倍」）が**回帰しない**こと。
5. 旧ゴールデン `tests/.gateb_T126.spec.ts` / `tests/.gateb_T105.spec.ts` は旧仕様（1/amplitude 強制）を検証しているため、新しい規約（snap 整数倍）に合わせて更新または削除する（orchestrator Gate B は `dynamic.test.ts` を使用するため、ライブテストは snap 整合性のみで判定）。

---

### [T130] エディタ内限定の音量バー（メトロノーム / 楽曲、各 0~300%）

**要件**: エディタ左ペイン `#music-control` 内に、メトロノーム音量と楽曲音量の2本のバー（0~300%）を追加。**エディタ内限定機能**（ゲーム画面・キャリブレーションには影響しない）。

**実装**:
- `EditorScreen` に `musicVolume`, `metronomeVolume` 状態（初期 100 = 100%）。`setMusicVolume`, `setMetronomeVolume` で値 0〜300 にクランプ。
- **エディタ専用のゲイン**を `AudioManager.getInstance().ctx.destination` の前に2本作成（`musicGain`, `metronomeGain`）。`EditingScreen` の `playFrom`（内部で `src.connect(ctx.destination)`）を `src.connect(musicGain)` に変更（`musicGain.connect(ctx.destination)`）。
- **メトロノーム**: `src/audio/metronome.ts` の `schedule(audioCtx, nextBeatTime, beat)` に任意の出力先引数 `out: AudioNode | undefined` を追加。`out` があれば `gain.connect(out)`、無ければ従来通り `gain.connect(audioCtx.destination)`。エディタの `startMetronome` は `schedule(audioCtx, nextBeatTime, beatIdx, metronomeGain)` を渡す。**ゲーム / キャリブレーションは引数なしのまま = エディタ限定**。
- **UI**: `#music-control` 内（メトロノームON/OFFトグルの近く）に、`<input type="range" min={0} max={300} step={5}>` の2本を追加。
  - メトロノーム音量: `data-testid="metronome-volume"` ラベル「メトロノーム音量」+ 現在%表示
  - 楽曲音量: `data-testid="music-volume"` ラベル「楽曲音量」+ 現在%表示
  - バー変更時にエディタの各gainへ即時反映。
- 永続化は不要（エディタ内のUI状態のみ）。localStorageは使わない（グローバル影響を避けるため）。

**完了条件（自動テスト）**:
1. `#music-control` 内に `metronome-volume` と `music-volume` の2つの音量バーが存在する。
2. `metronome-volume` を最小(0)にするとエディタ再生中のメトロノーム音が無音になり、最大(300)で聞こえる（ゲイン値で検証できる箇所、例 `__editorMetronomeGain` 等の露出、またはgain.gain.valueの検査で判定）。
3. `music-volume` がエディタ楽曲再生のゲインに反映される（`__editorMusicGain` のgain.gain.value等で判定）。
4. **エディタ限定**: ゲーム画面（GameScreen）とキャリブレーション（CalibrationScreen）の音響ルーティングが変更されていない（`schedule()` の `out` 引数なし呼び出しは従来どおり `ctx.destination` へ接続）。

---

### [T131] 速度係数を「BPM変更エントリー」の振幅としてリスト駆動で時変させる

**要件（ユーザー確定）**: メインの `#amplitude` 入力欄（`BpmEditor`）は**リストではない注入値フィールド**。値変更時の編集画面（波形/カーソル）への**即時適用は廃止**。「BPM変更を追加」を押したとき、その時点の `#amplitude` の値を**新規BPM変更エントリーの `amplitude` としてスタンプ**して登録。**編集画面の波形・カーソルは `bpm_changes[].amplitude` のリストに従って変化**する（リスト駆動。`Chart.amplitude`（ベース）ではなくリストから決まる）。

**モデル**:
- `BpmChange` に `amplitude?: number`（速度係数、>0）を追加。
- `amplitudeAt(beat)`: `bpm_changes` のうち `beat` 以下の変更で `amplitude` を持つ**最新**の値を返す（step関数、BPM と同様）。`beat` で適用する振幅を持つ変更が1つも無い場合は `Chart.amplitude`（ベース、既定1.0）を返す。
- `Chart.amplitude` は後方互換・TOML出力用に維持（エディタの操作ではリストが主駆動源）。

**実装**:
- `src/types.ts`: `BpmChange { beat: number; bpm: number; amplitude?: number }`。
- `src/screens/editor/BpmEditor.tsx`:
  - `addChange()`: `onBpmChangesChange([...bpmChanges, { beat: defaultBeat, bpm: safeBpm(bpm), amplitude: safeAmp(amplitude) }])`（メイン入力欄の現在値をスタンプ）。
  - メイン `#amplitude`（:104-119）: `onAmplitudeChange` による**即時レンダリング反映を廃止**。入力保持のみ（次エントリーへの注入値）。ラベルは「速度係数（BPM変更に注入する値）」等へ変更。
  - BPM変更リストの各行に振幅の表示/編集（`input` で `.amplitude` を編集可能、空なら `Chart.amplitude` 継続）。
- `src/audio/bpmTimeline.ts`: `BpmSegment` に `amplitude` を追加し、`bpm_changes[].amplitude` から `amplitudeAt(beat)` を公開（base = `Chart.amplitude`）。
- `src/game/waveEngine.ts`: `buildPoints` を **セグメント開始拍の振幅** `amplitudeAt(segStartBeat)` で per-beat変位 `2*TW_AMP*amplitudeAt(...)` を算出し、T128の`dY`（`WavePoint.dY`）に反映（クランプは上下幅 `TW_AMP` 維持）。`getPoints()` の長さ（セグメント数+1）と `{beat,y}` 構造は不変。
- `src/game/cursor.ts`: `update` で現在拍の振幅 `amplitudeAt(currentBeat)` を使うよう、毎フレーム振幅を更新（timeline またはゲッター持参）。
- `src/screens/GameScreen.tsx`: ループ中 `currentBeat`（:312）から `cursor` の振幅を `timeline.amplitudeAt(currentBeat)` に更新。`WaveEngine` 構築は `(segments, timeline, chart.amplitude, chart.start_position)` のまま（timeline が `amplitudeAt` を持つ）。
- `src/screens/editor/WavePreview.tsx` / `EditorScreen.tsx`: リスト駆動の時変振幅で描画・録音（`segmentize` のthreshold等）に反映。
- `src/chart/loader.ts` / `serialize.ts`: `bpm_changes[].amplitude` を取り込む / 出力（`[[bpm_changes]]` に `amplitude = X`、設定時のみ）。

**完了条件（オフグリッド必須）**:
1. `amplitudeAt(beat)`: 振幅変更点（例 beat=4 で 1.0→2.0）に対し、変更前の端数拍（例 3.37）と変更後の端数拍（例 4.23, 4.37）で返す値がそれぞれ 1.0 / 2.0 になる（step、オフグリッド検証）。
2. `WaveEngine.waveYAt` の区間傾斜が `2*TW_AMP*amplitudeAt(segStartBeat)` と一致（T128/T129の数値整合、複雑な振幅値で直接比較）。`getPoints().length === segments.length + 1` を維持。
3. `BpmEditor.addChange` で、メイン `#amplitude` を変更（例 2.5）→「BPM変更を追加」→ 新規エントリーの `.amplitude` が 2.5 である。
4. **即時適用の廃止**: メイン `#amplitude` を変更しても、追加ボタンを押すまで編集画面の波形/カーソル（`__editorSegments`/`__editorWaveEngine.waveYAt` 等）が変化しないこと。
5. 既存チャート（`bpm_changes[].amplitude` 未設定）は従来どおり `Chart.amplitude` ベースで動作（後方互換）。T127/T128/T129の回帰なし。

---

## よくある迷い → デフォルト

| 迷った場合 | デフォルト |
|---|---|
| 派手 vs 地味 | 地味 (transition 200ms) |
| 分割 vs 1ファイル | 200行超えたら分割 |
| 状態管理ライブラリ | 使わない (useState/useReducer) |
| anyで型を誤魔化す | 禁止。unknownを使え |
| 仕様にない機能追加 | TODOコメントのみ |
| TOMLにないキー | デフォルト値で補完 |
| アニメーション時間 | 150-200ms |
| z-index | 10刻みで管理 |
