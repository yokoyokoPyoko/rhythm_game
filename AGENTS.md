# AGENTS.md — リズムゲーム自律開発仕様書

対象読者: AIエージェント（実装者）
このファイルを必ず最初に読め。各タスクIDの仕様セクションのみを参照して実装すること。

---

## 行動ルール（全タスク共通・最優先）

1. **質問禁止**: 不明点は自分で最善を判断して実装。迷ったら最もシンプルな実装を選ぶ。
2. **ゲーミング禁止**: 虹色・過剰グロー・パーティクル爆発・レインボーRGBは一切使わない。
3. **スコープ厳守**: 当該タスクの仕様に書いてない機能を追加しない。追加したい場合はTODOコメントのみ。
4. **ビルドエラー即修正**: `tsc --noEmit` エラーは次ファイルを触る前に必ず修正。
5. **迷ったらLinear**: デザイン判断はLinear.app / Vercel dashboardを基準にする。
6. **詰まったら30分でスキップ**: 30分解決しなければTODOコメントを書いて次タスクへ。

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
- **リリース位置の正確なスナップ**: キーを離した瞬間（keyup）の beat を snap グリッド（`quantizeBeat(beat, snap)`）に吸着させ、直前のスナップ区間に引きずられてセグメントが不要に伸びる（オーバーシュートする）現象を解消。
- **キー操作に応じたセグメント生成**: 押下開始から離すまでの区間を正確に `up`/`down` セグメント化し、離している区間は `stay` としてスナップグリッド境界に整列。
- 完了条件: 録音中にキーを押して離した際、生成された各セグメントの `beats` が設定した `snap` の整数倍であり、キーを離した拍数以降に坂道が余分に伸びていないことを自動テストで確認。

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
