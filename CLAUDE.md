# CLAUDE.md — リズムゲーム（トレース・ウェーブ）

## 概要
文化祭用リズムゲーム。現在は **トレース・ウェーブ** 1 タイトルのみ（音波サバイバルは削除済み）。

## プロジェクト目標（初期会話からの抽出）
初期の企画会話（2026-06〜07）から抽出した、このリポジトリの背後にある目標・方針。

- **文化祭出展（最優先・短期）**: 1人でリズムゲームを制作、締切は文化祭（開始から約1ヶ月以内）。
  - 展示ブース向け → 短時間で「脳汁（報酬）が出る」高密度フィードバック設計。
  - 1人プレイ・スコア出力型（複数人対戦ではない）。
  - GitHub Pages (`github.io`) で公開 → Webベース、言語は **TypeScript**。
  - 操作はキー/タップ（マウス自由移動は却下：「リズムに縛られたい」）。
- **採用タイトル**: トレース・ウェーブ（＋音波サバイバルも検討されたが削除済み）。
  - トレース・ウェーブの要件: 上下キーでリズムに沿って波形移動（三角波）、円形リング拡大を維持、Spaceで乗り越え、判定演出を過剰に。
- **AI活用ルール（ENV.md に集約）**: 原因特定は agy(Claude Sonnet 4.6)、コード実装は OpenCode。
- **並行プロジェクト（優先順位注意）**: 受験（東工大情報系 総合型／共通テスト82%＋研究構造の活動実績報告書）、Wine/AviUtl2 開発（活動実績の種、ペース抑制）。同時進行はバーンアウトリスク。

## レイアウト
- `src/index.ts` — 全ロジック（単一ソース、Canvas 2D、約520行）。
- `docs/index.html` — GitHub Pages エントリ（`<canvas id="game">` 800×600、枠なし）。
- `docs/index.js` — `npx tsc` のビルド出力。**デプロイに必須**（Pages はコミット済み `docs/` を公開）。
- `/home/p-yoko/Downloads/trace_wave_prototype.html` — 初期プロトタイプ参考。

## ビルド / デプロイ
```
npm run build              # tsc → docs/index.js
git add src/index.ts docs/index.js && git commit && git push   # デプロイ
```
- 公開: `https://yokoyokoPyoko.github.io/rhythm_game/`（branch main, /docs）
- 反映まで最大10分キャッシュ → 検証時はハードリフレッシュ（Ctrl/Cmd+Shift+R）

## アーキテクチャ
- **ゲームループ**: `requestAnimationFrame` → `songNow()` で時刻更新 → `update()` / `render()`。
- **音声クロック（重要）**: `songNow()` は `audioCtx.currentTime` ベース。メトロノームは lookahead スケジューラで `audioStartTime + beat*beatSec` に予約。
- **ループ内状態**: `gameMode`("menu"|"tracewave"), `bpm`, `songTime`, `twState`。
- **キー入力**: `keydown` で `keysJust` / `keys` をセット。`Space` 押下時は `audioCtx.currentTime` を `spaceHitSong` に即座保存し、判定に使う（フレーム遅延排除）。
- **オフセット調整**: `manualOffsetMs`（localStorage 保存）。`<`/`>` で±10ms手動調整、`L` キーでオートキャリブレーション（Space×8回、完了後メニューに戻る）。

## トレース・ウェーブの定数（`src/index.ts`）
- `TW_JUDGE_X = W*0.26`, `TW_CENTER_Y = H/2`, `TW_AMP = 80`, `TW_SCROLL = 110`
- `TW_LEAD_BEATS = 3`, `TW_TOLERANCE = 26`, `TW_SNAP = 0.10`
- `tierColorsTW = ["#4cc9f0","#56e39f","#ffb454","#ff5d6c"]`（コンボ段階の状態色）

## タイミングの同期設計（解決済み）
トレース・ウェーブにおける「波形の進行」「メトロノーム音」「リング判定」の3つのタイミング系は、以下の仕組みで完全に同期（単一の真理）するよう解決されています。
- **基準クロック**: `audioCtx.currentTime` を唯一の真理として `songNow()` を計算。
- **入力の即時性**: Space押下時に即座に打鍵音を再生し、`currentTime` を保存してフレーム遅延を排除。
- **環境遅延の手動補正**: 環境ごとの物理的な特大遅延（250ms等）に対応するため、オートキャリブレーション等ではなく手動オフセット（`<`, `>`キー）による `manualOffsetMs` 加算方式を採用。プレイヤー自身で最適な値に調整できる。

## 開発ルール（ENV.md より）
- コードは OpenCode が記述。バグ調査のみ `./debug-investigate.sh "<症状>"` で agy(Claude Sonnet 4.6) に依頼（原因特定のみ、編集なし）。
- 試行錯誤は `DEVELOPMENT_LOG.md` に時系列で記録。
- シンプル・イズ・ベスト、最小修正。
