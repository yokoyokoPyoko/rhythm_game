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

### [T132] エディタ録音時の判定オフセット（`</>`微調整＋エディタ内キャリブレーション）

**背景**: 環境によってスペースキーの遅延が発生し、プレイモードでは `</>` キー（T60）と CalibrationScreen（T61）で判定オフセット（`manualOffsetMs`）を調整できる。しかしエディタの録音打刻は `positionRef.current` を無補正で beat 化しており、キーレイテンシ分だけリング/セグメントがずれて記録される。エディタ録音時にも同じオフセットを反映し、同じ仕組みのキャリブレーションをエディタ内で実行できるようにする（ユーザー確認済みの方針）。

**1. 録音時のオフセット補正（リング＋セグメント両方）**
- `src/screens/EditorScreen.tsx`: 録音中の**キー打刻イベント**の基準位置を `pos' = positionRef.current - getManualOffsetMs()` に補正してから `timeline.msToBeat(pos')` で beat 化する（タップが遅れて記録される分を前に引く）。
- 適用箇所（すべて `timeline.msToBeat(...)` の引数を補正済み `pos'` へ）:
  - リング Space 押下（開始beat）: `spacePressBeatRef.current = quantizeBeat(msToBeat(pos'), snap)`（:620-622）
  - リング Space 離し（hold長の終端）: `snapped`（:714-715）
  - セグメント矢印キー離し打刻（T105 `releaseBeat`）: `:690` の `releaseBeat` 算出
- **連続軌跡サンプル（録音ループの `beat = quantizeBeat(msToBeat(pos), snap)`）は補正しない**（真の曲位置を記録するため）。`finishRecording` の `startBeat`（`recStartBeatRef`）は録音開始位置なので補正しない。
- 補正は `mode === 'record' && isPlaying` 中のキー打刻に限定（T102/T103 の「再生中スタンプ禁止」を壊さない）。

**2. エディタに `</>` のオフセット微調整切手（±10ms）＋表示**
- `EditorScreen` の `onKeyDown` に `,`/`<` と `.`/`>` のハンドラを追加（`setManualOffset(getManualOffsetMs() + delta)`、delta=∓10）。`GameScreen.tsx:408-412` の `adjustOffset` と同様の実装。
- 音楽制御ペイン `#music-control` に `offset: +Xms` 表示を追加（`GameScreen.tsx:509` と同形式）。`data-testid="editor-offset"`。
- `getManualOffsetMs` / `setManualOffset` は `src/audio/clock.ts` から import。

**3. エディタ内キャリブレーションモーダル（プレイモードと同一仕組み）**
- `#music-control` に「キャリブレーション」ボタン（`data-testid="editor-calibration-button"`）→ エディタ内モーダル（`src/screens/editor/CalibrationModal.tsx` を新規作成。画面遷移せず編集中状態を保持）。
- ロジックは `CalibrationScreen.tsx` と同一: CAL_BPM=120、Space×8回、最初の2サンプル破棄、残り6の平均を `setManualOffset`。初回Spaceで `setManualOffset(0)` してから計測。メトロノームは `schedule(audioCtx, nextBeatTime, beat)`（エディタ限定の音量適用は任意）。ESC と「閉じる」ボタンでキャンセル。
- **キャンセル時の復元**: モーダルオープン時に直前オフセットを保持し、ESC/閉じるでキャンセルした場合は `setManualOffset(直前値)` で復元（変更を保存しない）。

**完了条件（自動テスト）**:
1. `setManualOffset(+80)` 状態でエディタ録音（stub AudioContext 可）→ Space押下で記録されるリングの beat が `quantizeBeat(msToBeat(tapPos - 80), snap)` に一致（hold の終端・矢印離しのセグメント打刻も同式）。
2. エディタで `<`/`>` キー → `getManualOffsetMs()` が ±10 変化し、`#music-control` 内の `editor-offset` 表示が更新される。
3. エディタ内キャリブレーションモーダル: Space×8 計測完了で `getManualOffsetMs()` が平均値になる。ESC/閉じるでキャンセルした場合は直前オフセットへ復元される。
4. 回帰なし: T102/T103（playモード中のリング/セグメントスタンプ禁止）、T100（hold録音反映）、T105（リリース吸着）、T129（snap整合性）。録音ループの連続軌跡 beat が補正されないこと。

---

### [T133] プロセカ風フルスクリーンキャリブレーションオーバーレイ（ループ練習譜面）

**背景・ユーザー要望**: T132で作ったエディタ内キャリブレーションモーダル（`CalibrationModal.tsx`）は、(1) キャリブレーション中にエディタの楽曲再生（BGM）が重複して鳴る、(2) エディタの音楽再生状態（`positionRef`/`isPlaying`）に依存している、(3) 独立ルート `/calibration`（`CalibrationScreen.tsx`）が残っていて画面遷移の設計が分かれている、という問題がある。これを全画面オーバーレイ方式に統一し、プロセカ風の「無限ループ譜面を好きなだけプレイして、好きなタイミングで終了」方式に刷新する。

**決定した仕様（ユーザー確定）**:
- 専用ルート `/calibration` と `CalibrationScreen.tsx` は**完全削除**。
- キャリブレーションは**フルスクリーンオーバーレイ**（エディタのプレイテスト `playtest-overlay` と同様の描画を全画面に重ね、操作も占有する方式）として、曲選択画面とエディタ画面の両方から同一コンポーネントを起動する。
- キャリブレーション時は**楽曲再生（BGM）を無効化**（キー自体の重複は許容、音楽の重複は不可）。背景の楽曲・BGM・録音・メトロノームをオーバーレイ起動時に即時停止する。
- **プロセカ風・無限ループ練習譜面**: 単純な譜面をやらせっぱなしにして、好きな時に終了できる。
  - BPM: 120（固定）
  - リング: 1小節に1回 → 4拍ごと（beat 4, 8, 12, 16, ...）
  - 波形セグメント: 2拍ごとに上下交互（2拍 up / 2拍 down / 2拍 up / 2拍 down ...）
  - 「あと一拍連れで押してしまう」回避のため、このリズム（1小節1リング＋2拍ごと上下）を固定する。

**実装**:
- `src/App.tsx`: `<Route path="/calibration" ... />` を削除。`CalibrationScreen` の import を削除。
- `src/screens/CalibrationScreen.tsx`: **削除**。
- `src/screens/editor/CalibrationModal.tsx`: プロセカ風フルスクリーンオーバーレイ（`CalibrationOverlay`）へ置き換え（同一ファイル名・`data-testid="editor-calibration-modal"` 維持か、新規 `CalibrationOverlay.tsx` でも可。ただし専用ルート非依存・画面遷移なし・フルスクリーン必須）。
- `src/screens/SelectScreen.tsx`: `L` キーハンドラを `navigate('/calibration')` からオーバーレイ起動（例 `setCalibrationOpen(true)`）に変更。別途「キャリブレーション」ボタン（`data-testid="select-calibration-button"`）も追加可。
- `src/screens/EditorScreen.tsx`: 「キャリブレーション」ボタン（`data-testid="editor-calibration-button"`）は T132 のまま、起動コンポーネントをフルスクリーンオーバーレイへ変更。オーバーレイ起動時は `stop()` / `stopMetronome()` を呼び**楽曲・BGM・録音を完全停止**してから開く。
- **無限ループ譜面の生成**:
  - `Chart` 相当のデータ（`segments`, `rings`）を固定パターンで大量生成（例: 数百拍分を再帰的に生成するか、少なくとも長時間 = 例 20分以上 / 500小節以上相当）。
  - BPM=120 固定の `BpmTimeline`。セグメント: `up 2拍 / down 2拍` を繰り返し。リング: `beat = 4, 8, 12, 16, ...` 各 `{ beat, type: 'single' }`。
  - 生成は `GameScreen` に食わせる `Chart` 形式（`src/types.ts` の `Chart`）として構築。
- **操作（プロセカ風）**:
  - メトロノーム（`schedule`）と無限ループ譜面を同時再生し、Space でリングを叩いて判定させる。
  - 判定結果と打刻誤差（例 `PERFECT (+12ms)`）を判定線付近にリアルタイム表示。
  - `,`/`<`（-10ms） `.`/`>`（+10ms）キーまたは画面上の `-10ms`/`+10ms` ボタンで `manualOffsetMs` をリアルタイム微調整。
  - **「保存して終了」ボタン（`data-testid="calibration-save"` または Enter）**: 現在のオフセットを `setManualOffset()` で保存してオーバーレイを閉じる。
  - **「キャンセル」ボタン（`data-testid="calibration-cancel"` または ESC）**: 開始前のオフセットに復元して保存せず閉じる（T132 の復元仕様を維持）。
  - ループ再生は好きなタイミングで終了できる（やらせっぱなし方式。決め打ちの「8回タップで自動完了」は廃止）。

**完了条件（自動テスト）**:
1. `/calibration` ルートが存在しない（`App.tsx` に `path="/calibration"` が無い、`CalibrationScreen.tsx` が削除済み）。
2. キャリブレーションはフルスクリーンオーバーレイとして起動し、Space 入力がエディタの音楽再生・録音と重複しない（オーバーレイ起動時に背景楽曲が停止している=`isPlaying` が false になる / `stop()` が呼ばれる）。
3. プロセカ風譜面が正しく生成される（BPM=120、セグメントが `up 2拍 / down 2拍` 交互、リングが 4拍ごと = beat 4,8,12,...）。
4. 無限ループ・やらせっぱなしで、Space でリングを叩くと判定・誤差が表示され、「保存して終了」で `setManualOffset` が保存されオーバーレイが閉じる。「キャンセル」/ESC では開始前オフセットへ復元され保存されない。
5. 回帰なし: T132（録音オフセット補正）・T102/T103（playモードスタンプ禁止）・T129（snap整合性）。`L` キー起点のテスト（t61/t91/select-screen.spec.ts）はオーバーレイ方式に更新。

---

### [T134] エディタ内キャリブレーションオーバーレイ時のキー入力独占（BGM/メトロノーム重複・`</>`二重適用の修正）

**バグ（ユーザー報告・原因特定済み）**: エディタ内キャリブレーション（`CalibrationModal` フルスクリーンオーバーレイ）表示中も、元の `EditorScreen` の `window` keydown/keyup リスナーが登録されたまま有効で、**1回のキー押下で編集画面とオーバーレイの両方が発火**する。

- **Space**: エディタ側が `playFrom()` で BGM 開始/停止し、さらに `isPlaying=true` で `:280-292` のメトロノームeffectが**エディタのメトロノームを再起動**（オーバーレイのメトロノームと二重に鳴る）。その上でオーバーレイも `handleHit()` を実行。判定音と重なり「反応しない」ように見える。
- **`,` / `.`（`</>`）**: エディタ(±10)とオーバーレイ(±10)が両方適用され **1回押しで ±20ms** 動く。
- **↑/↓・ESC・Enter**: エディタ側も同時処理（実害は小さいが無駄）。

**原因**: `EditorScreen.tsx` の `onKeyDown`（:610）は `playtestActiveRef`（:611）しか抑制しておらず `calibrationOpen` は抑制対象外。`onKeyUp`（:702）は何のガードも無い。

**方針（ユーザー確定）**: キャリブレーション中は全画面オーバーレイなので、**全キー操作をオーバーレイが独占**させる。オーバーレイ表示中は `EditorScreen` のキーハンドラを無効化する（Playtest と同じ `playtestActiveRef` ガードパターン）。

**実装（`src/screens/EditorScreen.tsx` のみ・最小変更）**:
1. `calibrationOpenRef = useRef(false)` を追加し、`useEffect(() => { calibrationOpenRef.current = calibrationOpen }, [calibrationOpen])` で同期（既存 `:160-161` の `editModeRef`/`metronomeEnabledRef` 同期と同形式）。
2. `onKeyDown`（:610 先頭）の `if (playtestActiveRef.current) return` の直後に `if (calibrationOpenRef.current) return` を追加。
3. `onKeyUp`（:702 冒頭）にも `if (calibrationOpenRef.current) return` を追加（Space の hold 打刻や矢印リリースもオーバーレイ中は無効）。
4. オーバーレイを開くボタン onClick（:1109-1113、`stop()`/`stopMetronome()` の直後）で `calibrationOpenRef.current = true` を設定してから `setCalibrationOpen(true)`（`playtest` が :1211 で同期 set するのと同流儀。クリック直後の入力漏れ防止）。
5. オーバーレイを閉じる onClose（:1417-1423 の先頭）で `calibrationOpenRef.current = false` を設定。

`CalibrationModal.tsx` / `SelectScreen.tsx` / `GameScreen.tsx` は変更しない（オーバーレイ本体は T133 のまま）。

**完了条件（自動テスト）**:
1. エディタで `editor-calibration-button` クリック→オーバーレイ表示中に Space → `editor-play` の表示が「読込・再生」のまま（**エディタの再生・メトロノームが開始されない**）であり、`calibration-last` が判定テキストへ変化する（オーバーレイだけが反応）。
2. オーバーレイ中に `<` を1回 → `editor-offset` 表示が **-10ms ちょうど**変化（±20 でない）。`.` も +10 ちょうど。
3. オーバーレイ中に ESC/Enter/↑/↓ はオーバーレイ側のみに作用（ESC でオーバーレイが閉じる）。
4. オーバーレイを閉じた後、Space でエディタが再生開始（`editor-play` が「停止」表示）＝ガード解放を確認。
5. 回帰なし: `t61.spec.ts`（Lキー→オーバーレイ操作）、`t103.spec.ts`（play中 Space スタンプ禁止）、T133 QA gate（`tests/dynamic.test.ts`、特に T133-2「オーバーレイは positionRef/isPlaying に依存しない」）が通ること。

---

### [T135] 楽曲再生に判定オフセット（manualOffsetMs）を適用し、メトロノームと楽曲を同期

**バグ**: `metronome.ts:65` の `schedule()` は `offsetSeconds()`（`manualOffsetMs / 1000`）でメトロノームクリックをオフセットしているが、楽曲再生には `manualOffsetMs` が未適用。このため楽曲とメトロノームが `manualOffsetMs` 分だけズレ、`</>` キーでオフセットを変更するたびにズレが変化する。

**修正対象（2箇所のみ）**:
1. `src/screens/GameScreen.tsx` — `playMusic` 関数（:93-106）:
   - 現行: `const offsetSec = audioOffsetMs / 1000`
   - 修正: `const offsetSec = (audioOffsetMs + getManualOffsetMs()) / 1000`
   - `getManualOffsetMs` は既にインポート済み（:6）
2. `src/screens/EditorScreen.tsx` — `playFrom` 関数（:482-493）:
   - 現行: `const offsetSec = audioOffset / 1000`
   - 修正: `const offsetSec = (audioOffset + getManualOffsetMs()) / 1000`
   - `getManualOffsetMs` は既にインポート済み（:8）

**変更不要ファイル**:
- `metronome.ts` — 既に `offsetSeconds()` で適用済み
- `CalibrationModal.tsx` — 音楽再生なし、`schedule()` 経由で既にオフセット適用済み
- `clock.ts` / `songNow()` / `positionRef` — AudioContext ベースの時刻、変更不要

**完了条件（自動テスト）**:
1. GameScreen の `playMusic` が `(audioOffsetMs + getManualOffsetMs()) / 1000` を `offsetSec` として使用し、`source.start()` の開始タイミングに反映すること
2. EditorScreen の `playFrom` が `(audioOffset + getManualOffsetMs()) / 1000` を `offsetSec` として使用し、`src.start()` の開始タイミングに反映すること
3. `manualOffsetMs` を変更（例: +80ms）してから再生すると、楽曲開始タイミングがオフセット分だけずれ、メトロノームと同期する（AudioContext をモックして `start()` の引数を検証）
4. metronome.ts の `schedule()` が既に `offsetSeconds()` でオフセット適用済みであること（回帰なし）
5. `tsc --noEmit` エラーなし

---

### [T136] エディタ録音位置のバグ修正：緑バー（positionRef）を楽曲実位置に一致させ、録音打刻をそのまま使う

**バグ（ユーザー報告）**: エディタで録音したリング・セグメントが「再生位置（耳で聞こえた楽曲の位置）」に記録されずズレる。ユーザーの直感「録音の記録位置にオフセットが適用されていない」。

**根本原因**: `manualOffsetMs`（判定オフセット、キャリブレーション/`</>` キーで決まる global 値。`audioOffset`＝チャート設定 `audio_offset` とは別物）が、エディタ録音で**2つの逆向き効果**として適用され相殺するため、録音位置がズレる。

- 効果1（楽曲再生）: `playFrom`（`EditorScreen.tsx:482`、T135 で追加）は楽曲を `(audioOffset + manualOffsetMs) / 1000` 秒**遅らせて**鳴らす。
- 効果2（録音打刻）: 録音打刻（`:628/:714/:739`、T132 で追加）は `positionRef.current - getManualOffsetMs()` で打刻位置を**手前に**ずらす。
- さらに緑バー（`positionRef` 追跡式 `:364`）は `startMsRef + (ctx.currentTime - startCtxTimeRef) * 1000` でオフセットを無視してリアルタイム進行するため、緑バーは楽曲実位置より `(audioOffset + manualOffsetMs)` ms **進みっぱなし**になる（打刻で `-manualOffsetMs` を引いても `audioOffset` 分が残る）。

**確定方針（ユーザー承認）**: 「録音は聞こえた楽曲の位置にそのまま記録されるべき」「緑バーの位置＝聞こえている音の位置が常に一致すべき」。判定オフセット `manualOffsetMs` は録音に介入させない（ゲームの判定・メトロノーム・楽曲再生のみに効く）。つまり **緑バー（`positionRef`）を楽曲実位置に正確に一致させ、録音打刻はその位置をそのまま使う**。

**共通規約**: 楽曲の実際の開始遅延 = `leadMs = audioOffset + manualOffsetMs`（正: 遅れて鳴る / 負: 即鳴りでバッファが先から始まる）。緑バーが常に「楽曲実位置」を指すように追跡する。

**修正対象（`src/screens/EditorScreen.tsx` のみ）**:

1. **緑バー追跡式（`:364` と到達判定 `:365`、`stop()` `:565`）を楽曲実位置に統一**:
   ```
   leadMs = audioOffset + getManualOffsetMs()
   pos = startMsRef.current + (ctx.currentTime - startCtxTimeRef.current) * 1000 - leadMs
   ```
   - 正オフセット: 楽曲が遅れて鳴る分だけ緑バーも遅れて進む（鳴り始めるまでは `pos < 0` になり得る。描画・録音開始位置算出では 0 にクランプ）
   - 負オフセット: 即鳴りでバッファが先から始まる分、緑バーも先から進む
   - `pose >= endMsRef` 到達判定も同じ `pos` で行う

2. **録音打刻の `-getManualOffsetMs()` 補正を撤廃（3箇所）**。`positionRef` が楽曲実位置になったので、そのまま使う:
   - `:628`（リング Space 押下）→ `const pos = positionRef.current`
   - `:714`（セグメント矢印キー離し、T105 の releaseBeat 算出）→ `const pos = positionRef.current`
   - `:739`（リング Space 離し、hold 長終端）→ `const pos = positionRef.current`

**変更不要**:
- `src/screens/GameScreen.tsx` — 録音はエディタのみ。判定は `songNow()` ベースで厳密打刻補正がないため T135 のままで正しい
- `src/audio/clock.ts` / `src/audio/metronome.ts` — 変更なし
- 録音ループの連続軌跡サンプル（`:378-380`）— `pos`（修正後の `:364` 追跡）を beat 化するので、追跡式修正で自動的に楽曲実位置に整合
- `startRecording`（`:540`）の `startBeat` — `positionRef` 経由なので整合

**完了条件（自動テスト）**:
1. `playFrom` 後、緑バー（`positionRef`/`positionMs`）の追跡が `pos = startMsRef + (ctx.currentTime - startCtxTimeRef) * 1000 - (audioOffset + manualOffsetMs)` に一致すること。正（例 +80ms）・負（例 -80ms）オフセット両方で、楽曲実位置（=`src.start()` の when/offset から再現されるバッファ位置）と一致すること。
2. 録音打刻（リング Space 押下・矢印離し・リング Space 離し）が、`-getManualOffsetMs()` 補正なしの `positionRef.current`（＝楽曲実位置）で beat 化されること。`manualOffsetMs` を変えても打刻位置が変わらないこと（`audioOffset` は楽曲実位置に反映される）。
3. `audioOffset` が 0 でない（例 +200ms）場合、録音したリングが楽曲内の聞こえた位置（バッファ実位置）に記録されること（旧実装では `audioOffset` 分ズレていた）。
4. 回帰なし: T132 の「キャリブレーション/オフセット補正」「エディタ内キャリブレーションモーダル（`:editor-offset`、CalibrationModal）」「`:editor-offset` 表示」、T102/T103（play 中スタンプ禁止）、T129（snap 整合性）、T133（キャリブレーションオーバーレイ）。`GameScreen` の録音・判定は変更しないこと。
5. `tsc --noEmit` エラーなし。

---

### [T137] エディタ再生のメトロノーム決定性修正（再生ごとにズレるバグ）

**バグ（ユーザー報告）**: エディタで同じ位置から再生してもメトロノームのオフセットが毎回違う。`再生するごとにメトロノームのオフセットが毎回違う`。

**根本原因（コード確定）**:
- `playFrom(fromMs)` は `startMsRef=fromMs, startCtxTime=ctx.currentTime` を設定して `setPlaying(true)` するが、メトロノーム起動 `useEffect([isPlaying]:284-289)` は `startMetronome(ctx, positionRef.current)` と stale な `positionRef.current` を読む。`positionRef` は `tick(:381)` 更新前なので前回停止位置のまま。
- `startMetronome` の `nextBeatTime = ctx.currentTime + (beatToMs(beatIdx)-fromMs)/1000` は `ctx.currentTime` のジッタを含む。`while(nextBeatTime < now) advance` と `schedule` 内 `when = Math.max(now, nextBeatTime+offsetSeconds())` の二重 clamp で初回クリックがフレームタイミング依存でブレる。
- 音楽可聴 `② = ctxStart+offsetSec+(beatToMs(B)-fromMs)/1000` (`offsetSec=(audioOffset+manualOffset)/1000`) に対しメトロノーム可聴 `⑤ = ctxStart+(beatToMs(B)-fromMs)/1000+manualOffset/1000` で `audioOffset` 分だけ固定的にズレ、`ceil` の端数でブレとして知覚される。

**修正対象（`src/screens/EditorScreen.tsx` 中心）**:
1. `startMetronome` を決定論化: シグネチャを `startMetronome(ctx, fromMs, startCtxTime, leadMs)` に拡張し、`nextBeatTime` を `startCtxTime + leadMs/1000 + (beatToMs(beatIdx)-fromMs)/1000` ではなく `startCtxTime` 基準の決定論的計算に統一。`playFrom` 内で `setPlaying(true)` 前に直接 `startMetronome(ctx, fromMs, ctx.currentTime, leadMs)` を呼ぶか、`useEffect(isPlaying)` 経由の二重起動を廃止。`fromMs` は `playFrom` 引数の正値を用い `positionRef.current` の stale 読取を廃止。
2. `beatIdx` の残り計算を `leadMs` 込みで再計算し、`schedule` の `Math.max` clamp が初回で発動しないように `while` 補正を `leadMs` 込みで統一。
3. `audioOffset` をメトロノームにも反映: `T137` の時点で音楽②とメトロノーム⑤が `audioOffset` 込みで一致するようにする。
4. `stop()` / `seekTo` の `pos` 計算も同一 `leadMs` 式に統一するが、T138 で最終的に raw vs 可聴のどちらに寄せるかで再調整するため、T137 ではまず現行 T136 の `pos = startMs+delta-leadMs` を維持したまま決定性のみを直す。

**変更不要**: `src/audio/metronome.ts` の `schedule` ロジック自体は維持（`offsetSeconds()` 加算は残す）。`src/screens/GameScreen.tsx` は本タスクでは触らない。

**完了条件（自動テスト）**:
1. 同じ `fromMs` で `playFrom` を2回連続呼び出し、`__editorPlayFrom.when/offset` とメトロノーム初回 `when` の差が 5ms 以内で毎回一定（ジッタなし）。
2. `manualOffset=±80`, `audioOffset=0/200` の全組合せで音楽②とメトロノーム⑤の beat 対応が `audioOffset` 込みで一致。
3. `isPlaying` トグルを Space 連打しても `positionRef` stale 起因のブレが発生しない。
4. 回帰なし: T102/T103/T129/T133/T136。
5. `tsc --noEmit` エラーなし。

---

### [T138] 判定ライン＝緑バーの同一化（記録位置とプレイ判定の整合）

**背景**: T136 で `緑バー④ = 可聴位置②` に寄せた結果、Play の `判定① = songNow()` と `leadMs = audioOffset+manualOffset` 分ズレた。ユーザーの要望 `プレイの判定ライン＝緑のライン かつ 緑ライン上に生成であるべき` を満たすには両者を同一にする必要がある。現在 Play `① = raw`, Editor `④ = raw-leadMs` で `leadMs` ズレ。

**不整合の整理**:
- Play: `判定① = songNow = raw`, `可聴② = raw-leadMs` 相当（音楽が `+leadMs` 遅延）。
- Editor(現行T136): `緑④ = raw-leadMs = 可聴②`、録音 beat = `msToBeat(緑④)` → chart は可聴基準で保存。Play で再生すると `hitTime = beatToMs(可聴beat)` が `判定①` より `leadMs` 手前で判定される。

**確定方針（案Aを既定、案Bを代替として tasks.json で分岐）**:
- **案A（推奨・最小差分）– 緑④を判定①に寄せる**: Editor の `tick: pos = startMs+delta-leadMs` の `leadMs` 減算を撤廃し `pos = startMs+delta` (raw) に戻す。録音も `positionRef` そのまま → chart は raw(判定)基準で保存、Play と完全同相。副作用: 緑バーは可聴②より `leadMs` 進んで見えるが Play と一貫するため `判定ライン＝緑ライン` が成立。必要なら WavePreview に可聴ガイド点線を追加。
- **案B（判定①を可聴②に寄せる）**: `GameScreen.tsx` の `songNow` 判定を `songNowAudible = songNow - leadMs` に変更し、リング `hitTime`/ `judge`/ `waveYAtMs`/ `spawner` を可聴基準に。Editor は T136 のまま正となる。影響範囲が広く回帰リスク大。

**本タスクの実装範囲（案Aを採用）**:
- `src/screens/EditorScreen.tsx` のみ: `:366-368` と `stop():569-571` の `leadMs` 減算を削除し `pos = startMs + (ctx.currentTime-startCtxTime)*1000` に戻す。T137 で決定論化した `startMetronome` の `leadMs` 参照も raw 基準に合わせる（音楽②は `+leadMs` 遅延のまま、緑④は raw のため乖離は意図的）。
- `src/audio/clock.ts` に `getLeadMs(audioOffset)` ヘルパを一元化し、Game/Editor の `leadMs` 定義重複を解消。

**変更不要（案Aの場合）**: `src/screens/GameScreen.tsx` / `src/audio/metronome.ts` は触らない。案B を選ぶ場合は Game 側を上記通り変更するが、本タスクでは案Aを完了条件とする。

**完了条件（自動テスト）**:
1. Editor の `positionRef` 追跡が `pos = startMs + (ctx.currentTime-startCtxTime)*1000` (raw) に一致し、`manualOffset` を変えても緑バー軌跡が変わらない（判定基準は raw）。
2. Editor で録音したリング beat `B = msToBeat(greenPos)` を Play で再生したとき `songNow == beatToMs(B)` で判定ラインに到達（`leadMs` ズレなし）。
3. Editor で同じ位置から再生してもメトロノームと緑バーの相対位相が毎回一定（T137 の決定性を維持）。
4. 回帰なし: T135(音楽同期)/T136の音楽遅延は維持、T102/T103/T129/T133/T137。
5. `tsc --noEmit` エラーなし。

---

### [T139] 頂点編集の自由移動（左右上下）

**要求**: 頂点編集は左右上下に自由に移動できるようにする。現行 `WavePreview.tsx: vertexDragRef` は `beats`（横）のみ可変で Y は `direction` 保持のまま `WaveEngine` で再計算されるため上下自由移動ではない。これを譜面形式 `{direction, beats}` を変えずに実現する。

**方式（最小範囲調整・譜面互換維持）**: 頂点 `i` を `(beat', y')` へドラッグした際、前後 2 セグメントのみを再計算して整合させる。`perBeatPx = 2*TW_AMP*amplitudeAt(beat)`（`T131` の `bpm_changes[].amplitude` リスト駆動、既定 260px/拍）。`beatsNeeded = |y' - yPrev| / perBeatPx` を `safeSnap` に量子化し `<safeSnap` なら `safeSnap` に clamp。`y'` が clamp で届かない場合は `candidateEngine.waveYAt(beat')` に補正して描画と保存を一致させる。

- 対象: `points[i]`（`WaveEngine.getPoints()` の `i` 番目）。`beat' = quantize(xToBeat, safeSnap)`, `y' = clamp(mapYInverse(mouseY), fieldH)`。
- `seg i-1`: `beats_{i-1}' = |y' - y_{i-1}| / perBeat(prevBeat)`, `dir' = sign`
- `seg i`: `beats_i' = |y_{i+1} - y'| / perBeat(beat')`
- 両方 `safeSnap` 量子化、端点（`i=0/last`）は 1 セグメントのみ調整。`perBeat` は `amplitudeAt(prevBeat)` と `amplitudeAt(beat')` で個別に算出。
- 影響範囲は 2 セグメントのみ。`getPoints().length === segments.length+1` を維持。

**対象ファイル**: `src/screens/editor/WavePreview.tsx` のみ（`EditorScreen.tsx` は `onSegmentsChange` 既存コールバックを流用）。`WaveEngine` は変更なし。

**完了条件**:
1. Vertex モードで頂点をドラッグし X/Y ともに `safeSnap` 吸着で移動し、2 セグメントのみが伸縮すること。
2. 全 `segments[].beats` が `safeSnap` の整数倍であること。
3. `getPoints().length === segments.length+1` を維持し、後続 beat が `dx = beat' - beat_old` だけ正しくずれること。
4. 回帰: `T125`（Y は `WaveEngine` 物理で導出）/ `T128`（`dY` クランプ）/ `T139-142` 以外の挙動不変。`tsc --noEmit`。

---

### [T140] 辺編集のドラッグ移動（左右上下）

**要求**: 辺の編集はドラッグで左右上下に移動できるようにする。現行 `WavePreview.tsx: nearestEdgeIndex` はクリックで `onSelectSegment` のみでドラッグが無い。

**方式（最小範囲調整）**: 辺 `i`（頂点 `i→i+1`）を `(dxBeat, dy)` だけ平行移動し、前後を含む 3 セグメントを再計算して整合させる。

- `beat_i' = beat_i + dxBeat`, `beat_{i+1}' = beat_{i+1} + dxBeat`（`dxBeat` は `xToBeat` 差分を `safeSnap` 量子化）
- `y_i' = y_i + dy`, `y_{i+1}' = y_{i+1} + dy`（`dy` は `mapYInverse` 差分を `fieldH` 内 clamp）
- `seg i-1`: `p_{i-1}→p_i'` へ `beats/dir` 再計算
- `seg i`: `p_i'→p_{i+1}'` は辺自体。`beats_i' = |y_{i+1}' - y_i'| / perBeat(beat_i')` を `safeSnap` 量子化。`|dx| > |dy|` なら横優先で `beats_i'` を `dx` 起因に、逆は縦優先で `y` 起因に（見た目の主方向を優先）。
- `seg i+1`: `p_{i+1}'→p_{i+2}` へ再計算
- `edgeDragRef = {index, startBeat, startPrevBeat, startNextBeat}` を新設。`panRef` と排他（`edgeDrag` 中は pan 無効）。

**対象ファイル**: `src/screens/editor/WavePreview.tsx` のみ。`useEffect onMove` に `edgeDrag` ケース追加、`handleMouseDown` で `edgeHit` 時に `edgeDragRef` を初期化（現行の `onSelectSegment` 後にドラッグ開始も行う）。

**完了条件**:
1. Edge モードで辺をドラッグし 3 セグメントのみが再計算され、辺長が保たれたまま平行移動すること。
2. `safeSnap` 整数倍維持、`getPoints` 長さ不変。
3. 空ドラッグは pan、辺上ドラッグは edge 移動として正しく分離されること。
4. `tsc --noEmit`。

---

### [T141] 頂点のダブルクリック追加 / 右クリック削除

**要求**: 頂点をダブルクリックで追加、右クリックで削除できるようにする。現行は頂点追加手段なし、削除手段なし。

**方式**:
- **追加**: `onDoubleClick`（`e.detail===2, button 0`）で `beatAdd = quantize(xToBeat, safeSnap)`、所属セグメント `k`（`points[k].beat < beatAdd < points[k+1].beat`）を 2 分割。`yAdd = mapYInverse(mouseY)` を自由 Y とし、`segA: p_k→p_add` と `segB: p_add→p_{k+1}` に `beats/dir` を `|yAdd - y_k|/perBeat` で算出（`T139` と同様）。`segments.splice(k,1, segA, segB)`。
- **削除**: `onContextMenu`（`button 2`）で `nearestVertexIndex < 14px` なら頂点 `i` を削除し、前後 2 セグメント `seg_{i-1}, seg_i` を 1 本にマージ: `beats_merged = |y_{i+1} - y_{i-1}| / perBeat(prevBeat)`, `dir_merged = sign`。端点は削除不可。`e.preventDefault()` でブラウザメニューを抑止。

**対象ファイル**: `src/screens/editor/WavePreview.tsx` のみ。`onDoubleClick` を全モード対応に拡張（現行は `ring` のみ）、`onContextMenu` ハンドラを canvas に新設。

**完了条件**:
1. Vertex モードでダブルクリックした位置に頂点が +1 され、頂点数と `getPoints().length` が +1 されること。
2. 頂点上で右クリックすると該当頂点が -1 され、前後が 1 本にマージされること。即時削除でコンテキストメニューが出ないこと。
3. 追加/削除後の全 `beats` が `safeSnap` 整数倍であること。
4. `tsc --noEmit`。

---

### [T142] リング追加/削除の統一（ダブルクリック追加 / 右クリック削除）

**要求**: リングの追加/削除操作を頂点と同様（ダブルクリックで追加、右クリックで削除）に統一する。現行リングはクリック追加 / ダブルクリック削除。

**方式**:
- **追加**: 現行 `onMouseDown → pan.moved==false の mouseup で addRingAt` を **廃止**。`onDoubleClick`（`button 0, detail 2`）で `beat = quantize(xToBeat, safeSnap)` → `onAddRing(beat)`。`editMode==='ring'` かつ `nearestRingIndex` が hit していない空領域でのみ発火。
- **削除**: `onContextMenu`（`button 2`）で `nearestRingIndex < 35px` なら `onDeleteRing(hit)`。`e.preventDefault()` で抑止。ドラッグ（`dragRef`）は左クリックのみ有効（`e.button===0`）とし、右クリックドラッグでは `dragRef` を立てない。
- `handleMouseDown` の `panRef` 起点での `mouseup` 追加は削除し、ダブルクリックとの二重発火を `e.detail` と `panRef.moved` で厳密に分離。

**対象ファイル**: `src/screens/editor/WavePreview.tsx` のみ。

**完了条件**:
1. Ring モードで空領域をダブルクリックするとリングが +1 され、クリック単発では追加されないこと。
2. リング上で右クリックすると該当リングが -1 され、コンテキストメニューが出ないこと。
3. 左ドラッグでリング移動が従来通り機能し、右クリックドラッグでは移動しないこと。
4. 回帰: `T116`（V/E/R 分離）/ `T141` との右クリック排他が正しいこと。`tsc --noEmit`。

---

### [T143] メトロノームのオーディオオフセット反映撤廃（ルーラー/再生バー固定）

**要求**: メトロノームがオーディオオフセット（`audioOffset`）も反映されてしまうのを撤廃し、再生バー（緑バー）・編集画面のルーラー（`WavePreview` の beat グリッド）に固定してほしい。

**現状**: `EditorScreen.tsx: startMetronome` は `T137` で `leadMs = audioOffset`（`metronomeLeadRef.current = audioOffset`）を `nextBeatTime = startCtxTime + leadMs/1000 + (beatToMs(beatIdx)-fromMs)/1000` に焼き込み、`schedule()` 内でさらに `manualOffset` を加算することで `音楽② (=getLeadMs(audioOffset)/1000 + delta)` と一致させている。結果ルーラー（beat 目盛）とメトロクリックが `audioOffset` 分ズレる。

**修正**: `src/screens/editor/WavePreview.tsx` ではなく `src/screens/EditorScreen.tsx` の `startMetronome` のみ。
- `startMetronome(ctx, fromMs, startCtxTime, leadMs)` の `leadMs` 引数を削除し `startMetronome(ctx, fromMs, startCtxTime)` に。`nextBeatTime = startCtxTime + (beatToMs(beatIdx)-fromMs)/1000` に戻す（`T137` 前の純粋な ruler 基準、決定性の `startCtxTime` スナップショット化は維持）。`metronomeLeadRef` への `audioOffset` 代入と `while(nextBeatTime + manual/1000 < ctx.currentTime)` の `+manual` 補正を除去し `while(nextBeatTime < ctx.currentTime)` に。
- `playFrom` 内の `startMetronome(ctx, fromMs, t0, audioOffset)` 呼び出しを `startMetronome(ctx, fromMs, t0)` に。`useEffect([isPlaying])` 経由の `startMetronome(ctx, startMsRef.current, startCtxTimeRef.current)` も同様に `leadMs` なしに。
- `schedule()`（`src/audio/metronome.ts:65`）の `offsetSeconds()`（`manualOffset`）は残す。今回の要求は `audioOffset` の撤廃のみのため。完全固定（manual も含め）を求める場合は別タスクで分離。
- `GameScreen.tsx` の `Metronome` クラスは元々 `ctx.currentTime` 起点で beat 0 から刻むため ruler 固定済み、変更なし。

**完了条件**:
1. `audioOffset` を `0 → 200ms` に変えて再生しても、メトロクリックの `when` が `startCtxTime + (beatToMs(B)-fromMs)/1000 + manualOffset/1000` のまま（`audioOffset` 加算なし）で、ルーラーの beat 目盛り（`beatToX`）と緑バー通過時刻と一致すること。
2. 音楽可聴（`getLeadMs(audioOffset)/1000 + delta`）は従来通り `audioOffset` で遅延し、メトロと `audioOffset` 分ズレることが意図通りであること（テストでは音楽 when とメトロ when の差が `audioOffset` に一致することを検証）。
3. 同じ `fromMs` からの再生でメトロ初回 `when` が `audioOffset` に依らず一定（`T137` の決定性維持）。
4. `tsc --noEmit`。

---

### [T144] ルーラーを小節単位（0,1,2...）に変更

**要求**: 現行ルーラーが `0,4,8...`（beat 番号）の表示を `0,1,2...`（小節番号 = beat/4）に変更。

**現状**: `WavePreview.tsx:184-194` で `strong = b % 4 == 0` のときに `ctx.fillText(String(b), gx+4, 4)` で beat 番号を表示。`minorStep` は beat 単位でグリッド線を引くがラベルは 4 拍ごとのみ。

**修正**: `src/screens/editor/WavePreview.tsx` のみ。
- `if (strong)` ブロックのラベルを `String(Math.round(b / 4))` に変更。例 `b=0→"0"`, `b=4→"1"`, `b=8→"2"`。
- 線自体は `strong` 判定 `b%4==0` を維持（4 拍ごとに太線）。`minorStep` による細かい beat 線はそのまま残すため、見た目は「小節ごとに太線＋小節番号、間は細い beat 線」になる。

**完了条件**:
1. `viewBeats=16` などの初期表示でルーラー上部に `0,1,2,3,4`（小節）が表示され、`4,8,12` が表示されないこと。
2. `minorStep` の縦線（beat グリッド）は従来通り beat 単位で引かれ、小節太線と beat 細線が区別できること。
3. `tsc --noEmit`。

---

### [T145] ルーラーの拡大率しきい値調整（細かい拍が見えるように）

**要求**: 現行 `minorStep` の拡大率しきい値が広すぎてスペースが余り、細かい拍が見えない。しきい値を調整して拡大時に細かい拍が段階的に見えるようにする。

**現状**: `WavePreview.tsx:177` `minorStep = viewBeats<=8 ? 0.5 : viewBeats<=32 ? 1 : 4` の 3 段階。`viewBeats=16`（デフォ）でも `1` 拍刻みしか出ず、`viewBeats=32` 以上で一気に `4` 拍（小節）刻みに飛ぶ。

**修正**: `src/screens/editor/WavePreview.tsx` のみ。`minorStep` を 5 段階に細分化:

```ts
const minorStep =
  viewBeats <= 4  ? 0.25 : // 1/16拍まで（強拡大）
  viewBeats <= 8  ? 0.5  : // 1/8拍
  viewBeats <= 16 ? 1    : // 1拍
  viewBeats <= 64 ? 2    : // 2拍
                     4;   // 4拍（小節）
```

- `viewBeats=16`（初期）で `1` 拍、`viewBeats=8` で `0.5` 拍、`viewBeats=4` で `0.25` 拍まで見える。`viewBeats=32` でも `2` 拍刻みで空白が詰まる。

**完了条件**:
1. `viewBeats=4,8,16,32,64,100` の各拡大率で `minorStep` が上記 `0.25/0.5/1/2/4` に一致すること（ユニットテストで検証）。
2. ルーラーの小節ラベル（`T144` の `b/4`）は `strong` のときのみ表示されること（`minorStep` 変更でラベル密度が変わらない）。
3. `tsc --noEmit`。

---

### [T146] フォーカス時スクロール除去（ハイライトのみ）

**要求**: フォーカスするときにスクロールする機能を除去し、青くハイライトするのみにする。案A（`focus()` 自体を削除）を採用。

**現状**: `src/screens/EditorScreen.tsx:799-822` の `handleSelectRing` / `handleSelectSegment` は、WavePreview 上の頂点/リング選択時に右ペインの該当 `li`（`data-focus-id="ring-${index}"` / `segment-${index}`）へ `el.focus()` + `el.scrollIntoView({block:'nearest', behavior:'smooth'})` を実行する。`focus()` は `:focus-visible` の青輪郭とキーボードフォーカス移動のためだが、選択ハイライト本体は `ring-list-item-selected` / `segment-list-item-selected`（`border-color: var(--accent)`）のクラスで既に付くため `focus()` は必須ではない。`scrollIntoView` が右ペインをガタッとスクロールさせるのが問題。

**修正**: `src/screens/EditorScreen.tsx` のみ。`handleSelectRing` と `handleSelectSegment` の `requestAnimationFrame` 内の `el.focus()` と `el.scrollIntoView(...)` の **両方を削除**。`setSelectedRing/Segment` と `setRing/ SegmentDetailsOpen(true)` によるクラスベースの青ハイライトのみを残す。`requestAnimationFrame` 自体は `details` の `open` 反映待ちのため維持するが、中身は空（または `setSelected*` のみ）に近い形に。`focus({preventScroll:true})` は使わない（案A）。

**対象ファイル**: `src/screens/EditorScreen.tsx:804-820` の2箇所のみ。`WavePreview.tsx` / `SegmentEditor.tsx` / `index.css` は変更なし。

**完了条件**:
1. WavePreview 上のリング/頂点をクリックしても右ペインやページが一切スクロールしないこと。
2. 該当 `li` が `*-selected` クラスで青くハイライトされること（`focus()` 無しでも視認できる）。
3. `tsc --noEmit`。

---

### [T147] 頂点/辺ドラッグの直感性と影響範囲最小化のバグ修正

**バグ**: T139（頂点自由移動）と T140（辺ドラッグ）で、**直感的な左右上下移動ができず、影響範囲も最小（2/3 セグメント）になっていない**。頂点ドラッグでは `segFor` の `atTop/atBottom/Bt` 分岐が非対称でマウス Y と表示 Y が食い違い、辺ドラッグでは `beatsI = dx vs dy/pp` の大小分岐で斜めドラッグ時に閾値が不安定で辺長が保たれない。T131 の時変 `amp` と T128 の `dY` クランプを考慮していないため `candidateEngine.waveYAt` と保存 `beats` が不一致になるケースがある。

**修正方針**: `src/screens/editor/WavePreview.tsx` の `onMove` のみ。
- **頂点**: `beat' = quantize(xToBeat, safeSnap)` を `prevBeat+safeSnap … nextBeat-safeSnap` で clamp。`y' = clamp(mapYInverse(mouseY), fieldH)` を目標 Y とし、`beats_{i-1}' = quantize(|y' - yPrev|/perBeat(prevBeat), safeSnap)`, `beats_i' = quantize(|yNext - y'|/perBeat(beat'), safeSnap)` に統一。`perBeat = 2*TW_AMP*amplitudeAt(beat)` で個別算出。`dir = |d|<0.5 ? stay : d<0 ? up : down` に簡素化し、`candidateEngine = new WaveEngine(candidateSegs, timeline, ...)` で `waveYAt(beat')` を読み戻してマウス Y との誤差を `±0.5*perBeat*safeSnap` 以内に収める。端点は 1 セグメントのみ調整。
- **辺**: `dxBeat = quantize(beat - startBeat, safeSnap)`, `dy = clamp(newY - startY, fieldH)` を分離。`beat_i' = beat_i + dxBeat`, `beat_{i+1}' = beat_{i+1}+dxBeat`, `y_i' = y_i+dy`, `y_{i+1}' = y_{i+1}+dy` を `clamp` し、3 セグメント（`i-1, i, i+1`）を `segmentFor(fromBeat,fromY,toY)` で統一再計算。`seg_i` の `beats` は `max(quantize(|dxBeat|), quantize(|yI1-yI|/perBeat(beat_i')))` で横/縦の優先分岐を廃止し常時 Y 差分基準で決定。`edgeDragRef` に `startY` を追加し `panRef` と排他。

**完了条件**:
1. Vertex/Edge を複雑な `amp`（0.7/1.3/2.7）と端数拍（0.37/1.23）でドラッグし、マウス追従と `waveYAt` 表示が一致し、後続 beat が `dx` だけずれる以外は不変（2/3 セグメントのみ）。
2. 全 `beats` が `safeSnap` 整数倍、`getPoints().length === segments.length+1` 維持。
3. `tsc --noEmit`。

---

### [T148] 頂点/辺削除時の周辺変化最小化

**バグ**: T141（頂点削除）で `beats_merged = |yNext - yPrev|/perBeat` は Y 差分から逆算するため元の合計 `beats_{i-1}+beats_i` と一致せず、後続全体が `Δ = beats_merged - total` だけシフト。辺削除（未実装）も同様。

**修正方針**: `WavePreview.tsx: handleContextMenu` のみ。
- **頂点削除**（`vi`）: `totalBeats = segments[vi-1].beats + segments[vi].beats` を保存。`dir = |d|<0.5 ? stay : d<0 ? up : down`（`d = yNext - yPrev`）、`beats = quantizeBeat(totalBeats, safeSnap)`（**総拍数保存優先**）。後続ズレ `|Δ| < 0.5*safeSnap` のみ。表示 Y は `candidateEngine.waveYAt(prevBeat+beats)` で補正しマウス誤差を収める。端点は削除不可。
- **辺削除**（`ei`）: 辺 `i` を削除 → 頂点 `i+1` を削除と等価。`beats_merged = quantize(segments[i].beats + segments[i+1].beats, safeSnap)` で 2→1 マージ。前後 1 本のみ影響。

**完了条件**:
1. 頂点/辺削除前後で `totalBeats` が `±0.5*safeSnap` 以内で不変、後続波形が横に大きく動かないこと。
2. 削除で `getPoints().length` が `-1` のみ、追加→削除で round-trip しても総拍数が元に戻ること。
3. 全 `beats` が `safeSnap` 整数倍、`tsc --noEmit`。

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
