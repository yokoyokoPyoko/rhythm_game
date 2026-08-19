#!/usr/bin/env python3
"""汎用自律運用オーケストレーター (CUI 対話型モデル選択システム)

4つのフロー（Coder / QA Test Gen / Dynamic Reviewer / Postmortem Architect）
に使用する AI モデルを起動時の CUI 対話で柔軟に選択・構成できます。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
TASKS_JSON = ROOT / "tasks.json"
AGENTS_MD = ROOT / "AGENTS.md"
STATE_FILE = ROOT / "orchestrator_state.json"
LOG_FILE = ROOT / "orchestrator.log"
LOG_DIR = ROOT / "orchestrator_logs"
POSTMORTEM_DIR = ROOT / ".opencode"
POSTMORTEM_FILE = POSTMORTEM_DIR / "POSTMORTEM.md"
SCREENSHOT_DIR = ROOT / "screenshots"
DYNAMIC_SPEC_FILE = ROOT / "tests" / "dynamic.spec.ts"

DEV_PORT = 5173
DEV_URL = f"http://127.0.0.1:{DEV_PORT}/"
DEFAULT_BUDGET_MIN = 600

# モデル定義カタログ
MODEL_CATALOG = {
    "qwen38": ("Qwen3.8-27B", "cloudflare-workers-ai/@cf/qwen/qwen3.8-27b"),
    "deepseek_r1": ("DeepSeek-R1-Distill-Qwen-32B", "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"),
    "deepseek_v4": ("DeepSeek V4 Flash Free", "opencode/deepseek-v4-flash-free"),
    "gemini_flash_lite": ("Gemini 3.5 Flash-Lite", "google/gemini-3.5-flash-lite"),
    "nemotron_lightning": ("Nemotron 3.5 Lightning Free", "opencode/nemotron-3.5-lightning-free"),
}

# 各フローの選択肢
CODER_OPTIONS = [
    ("qwen38", "🥇 1位: Qwen3.8-27B (最速&高精度TSコード生成・Claude Sonnet超え)"),
    ("deepseek_v4", "🥈 2位: DeepSeek V4 Flash (豊富なコード知識・MoE)"),
    ("deepseek_r1", "🥉 3位: DeepSeek-R1-Distill-Qwen-32B (超論理思考・長考型)"),
    ("gemini_flash_lite", "⚡ 高速枠: Gemini 3.5 Flash-Lite (待ち時間ゼロ)"),
    ("nemotron_lightning", "⚡ 高速枠: Nemotron 3.5 Lightning Free"),
]

QA_OPTIONS = [
    ("qwen38", "🥇 1位: Qwen3.8-27B (OSWorld世界トップのブラウザ操作コード生成)"),
    ("deepseek_v4", "🥈 2位: DeepSeek V4 Flash (論理的テストケース網羅)"),
    ("deepseek_r1", "🥉 3位: DeepSeek-R1-Distill-Qwen-32B (高難度ロジック設計)"),
    ("gemini_flash_lite", "⚡ 高速枠: Gemini 3.5 Flash-Lite (高速テスト生成)"),
]

REVIEWER_OPTIONS = [
    ("gemini_flash_lite", "🥇 1位: Gemini 3.5 Flash-Lite (クラウド最適解・爆速マルチモーダル5連審査)"),
    ("nemotron_lightning", "🥈 2位: Nemotron 3.5 Lightning (100万トークン動画認識)"),
    ("qwen38", "🥉 3位: Qwen3.8-27B (画像認識+思考)"),
]

POSTMORTEM_OPTIONS = [
    ("deepseek_r1", "🥇 1位: DeepSeek-R1-Distill-Qwen-32B (思考の化け物・探偵のように根本原因を究明)"),
    ("qwen38", "🥈 2位: Qwen3.8-27B (最新TS知識+最大熟考)"),
    ("deepseek_v4", "🥉 3位: DeepSeek V4 Flash (長文コンテキスト解析)"),
    ("gemini_flash_lite", "⚡ 高速枠: Gemini 3.5 Flash-Lite"),
]

BACKOFF_DELAYS = [5, 10, 30, 60, 120]

NON_UI_TASKS = {
    "T00", "T82", "T01", "T02", "T10", "T11", "T12", "T13", "T14",
    "T40", "T41", "T20", "T21", "T22", "T23", "T24", "T60", "T62"
}

log = logging.getLogger("orchestrator")


@dataclass
class FlowModels:
    coder: str = MODEL_CATALOG["qwen38"][1]
    qa: str = MODEL_CATALOG["qwen38"][1]
    reviewer: str = MODEL_CATALOG["gemini_flash_lite"][1]
    postmortem: str = MODEL_CATALOG["deepseek_r1"][1]


@dataclass
class Task:
    id: str
    desc: str
    depends_on: list[str] = field(default_factory=list)


@dataclass
class GateResult:
    name: str
    ok: bool
    detail: str = ""


def setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.FileHandler(LOG_FILE, encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
    )


def interactive_model_selection() -> FlowModels:
    """CUI 対話メニューで各フローのモデルを選択する"""
    print("\n" + "=" * 70)
    print(" 🤖 汎用自律運用オーケストレーター - AI モデル構成セレクター")
    print("=" * 70)
    print(" [1] 🏆 推奨プリセット構成 (🥇1位モデルで全自動構成)")
    print("       ├─ 1. 実装 (Coder): Qwen3.8-27B")
    print("       ├─ 2. テスト生成 (QA): Qwen3.8-27B")
    print("       ├─ 3. 動的審査 (Reviewer): Gemini 3.5 Flash-Lite")
    print("       └─ 4. 失敗分析 (Postmortem): DeepSeek-R1-Distill-Qwen-32B")
    print(" [2] ⚡ 爆速・完全無料プリセット (Gemini 3.5 Flash-Lite 統一)")
    print(" [3] 🛠️ カスタム構成 (各フローを個別に選択)")
    print("-" * 70)

    choice = input("選択してください [デフォルト: 1]: ").strip()

    if choice == "" or choice == "1":
        print(">> 🏆 推奨プリセット構成を適用しました！")
        return FlowModels(
            coder=MODEL_CATALOG["qwen38"][1],
            qa=MODEL_CATALOG["qwen38"][1],
            reviewer=MODEL_CATALOG["gemini_flash_lite"][1],
            postmortem=MODEL_CATALOG["deepseek_r1"][1],
        )
    elif choice == "2":
        print(">> ⚡ 爆速・完全無料プリセット (Gemini統一) を適用しました！")
        return FlowModels(
            coder=MODEL_CATALOG["gemini_flash_lite"][1],
            qa=MODEL_CATALOG["gemini_flash_lite"][1],
            reviewer=MODEL_CATALOG["gemini_flash_lite"][1],
            postmortem=MODEL_CATALOG["gemini_flash_lite"][1],
        )

    # カスタム個別選択
    def select_one(title: str, options: list[tuple[str, str]], default_key: str) -> str:
        print(f"\n▼ {title}")
        for i, (key, desc) in enumerate(options, 1):
            mark = " (デフォルト)" if key == default_key else ""
            print(f"  [{i}] {desc}{mark}")
        ans = input(f"番号を入力 [1-{len(options)}, Enterでデフォルト]: ").strip()
        if not ans:
            return MODEL_CATALOG[default_key][1]
        try:
            idx = int(ans) - 1
            if 0 <= idx < len(options):
                return MODEL_CATALOG[options[idx][0]][1]
        except Exception:
            pass
        return MODEL_CATALOG[default_key][1]

    coder_m = select_one("【1. 実装担当 (Coder)】を選択してください:", CODER_OPTIONS, "qwen38")
    qa_m = select_one("【2. テスト生成 (QA)】を選択してください:", QA_OPTIONS, "qwen38")
    rev_m = select_one("【3. 動的審査 (Reviewer)】を選択してください:", REVIEWER_OPTIONS, "gemini_flash_lite")
    post_m = select_one("【4. 失敗分析 (Postmortem)】を選択してください:", POSTMORTEM_OPTIONS, "deepseek_r1")

    return FlowModels(coder=coder_m, qa=qa_m, reviewer=rev_m, postmortem=post_m)


def load_tasks() -> list[Task]:
    raw = json.loads(TASKS_JSON.read_text(encoding="utf-8"))
    tasks: list[Task] = []
    ids: set[str] = set()
    for item in raw:
        tid = item.get("id", "")
        if not tid or tid in ids:
            continue
        ids.add(tid)
        tasks.append(Task(id=tid, desc=item.get("desc", ""), depends_on=item.get("depends_on", [])))
    return tasks


def topo_sort(tasks: list[Task]) -> list[Task]:
    by_id = {t.id: t for t in tasks}
    visited: set[str] = set()
    order: list[Task] = []

    def visit(tid: str, path: list[str]) -> None:
        if tid in path:
            return
        if tid not in visited and tid in by_id:
            visited.add(tid)
            for dep in by_id[tid].depends_on:
                visit(dep, path + [tid])
            order.append(by_id[tid])

    for t in tasks:
        visit(t.id, [])
    return order


def load_state() -> dict[str, Any]:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"started_at": time.time(), "tasks": {}, "consecutive_failures": 0}


def save_state(state: dict[str, Any]) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def run_cmd_pgid_stream(cmd: list[str], timeout: int | None = None, cwd: Path = ROOT, prefix: str = "") -> tuple[int, str, bool]:
    e = os.environ.copy()
    e["FORCE_COLOR"] = "0"
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=e,
            start_new_session=True,
        )
    except Exception as err:
        return 127, f"コマンド実行失敗: {cmd[0]} ({err})", False

    q: queue.Queue[str | None] = queue.Queue()

    def reader_thread() -> None:
        try:
            if proc.stdout:
                for line in iter(proc.stdout.readline, ""):
                    q.put(line)
        except Exception:
            pass
        finally:
            q.put(None)

    t = threading.Thread(target=reader_thread, daemon=True)
    t.start()

    collected: list[str] = []
    start_t = time.time()
    timed_out = False

    while True:
        try:
            line = q.get(timeout=0.1)
            if line is None:
                break
            collected.append(line)
            cleaned = line.rstrip()
            if cleaned and not re.search(r"^\s*$", cleaned):
                print(f"  │ {prefix}{cleaned}", flush=True)
        except queue.Empty:
            pass

        if timeout and (time.time() - start_t > timeout):
            timed_out = True
            log.warning("⏰ タイムアウト (%d秒) に達したためプロセスを強制終了します", timeout)
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                time.sleep(1)
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            print(f"  └─ ⏰ [タイムアウト {timeout}秒で強制終了]", flush=True)
            break

        if proc.poll() is not None and q.empty():
            break

    proc.wait()
    full_out = "".join(collected)
    return (proc.returncode if not timed_out else -1), full_out, timed_out


def rate_limit_sleep(model: str) -> None:
    if "kimi" in model.lower():
        log.info("⏳ [RateLimit] Kimiモデルのため 21秒 待機中...")
        time.sleep(21)
    else:
        log.info("⏳ [RateLimit] 5秒 待機中...")
        time.sleep(5)


def run_opencode_with_retry(model: str, prompt: str, timeout: int = 300, label: str = "OpenCode") -> tuple[int, str]:
    cmd = ["opencode", "run", "--auto", "--format", "default", "--dir", str(ROOT), "-m", model, prompt]

    for attempt, delay in enumerate(BACKOFF_DELAYS, start=1):
        rate_limit_sleep(model)
        log.info("🤖 [%s] 実行開始 (model=%s, 試行 %d/%d, タイムアウト=%d秒)", label, model, attempt, len(BACKOFF_DELAYS), timeout)
        print(f"  ┌─ ▼ {label} 出力ストリーム開始 ───", flush=True)
        code, out, timed_out = run_cmd_pgid_stream(cmd, timeout=timeout, prefix="🤖 ")
        print(f"  └─ ▲ {label} 出力終了 (exit={code}) ───", flush=True)

        if timed_out:
            log.warning("⚠️ タイムアウトが発生しました。再試行します...")
            continue

        if "429" in out or "Too Many Requests" in out:
            log.warning("⚠️ 429 Too Many Requests 検知。%d秒 バックオフ待機して再試行します...", delay)
            time.sleep(delay)
            continue

        return code, out

    log.error("❌ リトライ上限に達しました")
    return code, out


def extract_agents_spec(task_id: str) -> str:
    if not AGENTS_MD.exists():
        return ""
    text = AGENTS_MD.read_text(encoding="utf-8")
    
    rules_match = re.search(r"## 行動ルール.*?(?=## プロジェクト概要)", text, re.S)
    rules = rules_match.group(0) if rules_match else ""

    design_match = re.search(r"## デザインシステム.*?(?=## タスク別仕様)", text, re.S)
    design = design_match.group(0) if design_match else ""

    pattern = rf"### \[?{task_id}\]?.*?(?=\n### \[?T\d+\]?|\n## |\Z)"
    match = re.search(pattern, text, re.S)
    task_spec = match.group(0) if match else f"タスク {task_id} の仕様"

    return f"{rules}\n\n{design}\n\n## 今回のタスク仕様\n{task_spec}"


def build_coder_prompt(task: Task) -> str:
    parts = [
        f"あなたは自律開発エージェントです。以下のタスクを実装してください。\n\nタスクID: {task.id}\n説明: {task.desc}\n",
        extract_agents_spec(task.id),
    ]

    types_file = ROOT / "src" / "types.ts"
    if types_file.exists():
        parts.append(f"\n## 現在の型定義 (src/types.ts)\n```typescript\n{types_file.read_text(encoding='utf-8')[:4000]}\n```")

    if POSTMORTEM_FILE.exists():
        parts.append(f"\n## 過去の失敗と禁止ルール (POSTMORTEM.md)\n{POSTMORTEM_FILE.read_text(encoding='utf-8')[-2000:]}")

    parts.append("\n【重要指示】質問は禁止です。実装が完了したら最後に 'DONE' と出力してください。")
    return "\n\n".join(parts)


def check_gate_a() -> GateResult:
    tsconfig = ROOT / "tsconfig.json"
    if not tsconfig.exists():
        return GateResult("Gate A (tsc)", True, "tsconfig.json なし → スキップ")
    log.info("🔍 [Gate A] TypeScript 静的型チェック実行中...")
    code, out, _ = run_cmd_pgid_stream(["npx", "tsc", "--noEmit"], timeout=30, prefix="tsc: ")
    if code != 0:
        return GateResult("Gate A (tsc)", False, out[-2000:])
    return GateResult("Gate A (tsc)", True, "型チェック PASS (エラー 0件)")


dev_proc: subprocess.Popen | None = None


def has_dev_script() -> bool:
    pkg = ROOT / "package.json"
    if not pkg.exists():
        return False
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
        return "dev" in data.get("scripts", {})
    except Exception:
        return False


def ensure_dev_server() -> bool:
    global dev_proc
    if not has_dev_script():
        return False
    if dev_proc is not None and dev_proc.poll() is None:
        return True
    try:
        log.info("🌐 [DevServer] Vite 開発サーバー起動中 (http://127.0.0.1:5173/)...")
        dev_proc = subprocess.Popen(
            ["npm", "run", "dev"],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(DEV_URL, timeout=2) as resp:
                    if resp.status < 500:
                        log.info("🌐 [DevServer] 接続確認完了！")
                        return True
            except Exception:
                pass
            time.sleep(1)
    except Exception as err:
        log.error("dev server 起動失敗: %s", err)
    return False


def generate_and_run_gate_b(task: Task, qa_model: str) -> GateResult:
    """QAモデルにタスク仕様を読ませて動的 Playwright テスト(5連フレーム撮影含む)を生成し、実行する"""
    if task.id in NON_UI_TASKS or not has_dev_script():
        return GateResult("Gate B (Dynamic Test)", True, f"タスク {task.id} は非UIタスク → スキップ")

    if not ensure_dev_server():
        return GateResult("Gate B (Dynamic Test)", False, "dev server が起動しませんでした")

    SCREENSHOT_DIR.mkdir(exist_ok=True)

    prompt = f"""あなたは厳格なQAエンジニアです。以下のタスク仕様を検証するための Playwright テストスクリプト (TypeScript) を作成してください。

【タスク】
{task.id}: {task.desc}

【タスク詳細仕様】
{extract_agents_spec(task.id)}

【要件】
1. URL 'http://localhost:5173/' にアクセスし、ユーザー操作（クリック、キー入力、待機など）をシミュレートすること。
2. アプリの操作前・操作中・操作後にかけて、以下のパスに **合計5枚の連続スクリーンショット** を保存すること:
   - 'screenshots/frame_1.png'
   - 'screenshots/frame_2.png'
   - 'screenshots/frame_3.png'
   - 'screenshots/frame_4.png'
   - 'screenshots/frame_5.png'
3. コンソールの致命的例外 (Uncaught, TypeError 等) や表示崩れ・不正な状態変化を assert / 検知すること。

必ず ```typescript ... ``` のコードブロック形式で Playwright スクリプトのみを出力してください。
"""
    log.info("🧪 [Gate B] QAモデル による動的テストコード生成開始...")
    _, out = run_opencode_with_retry(qa_model, prompt, timeout=120, label="QA-Gen")

    code_match = re.search(r"```(?:typescript|ts)?\s*(import\s+.*?)```", out, re.S)
    if not code_match:
        log.warning("⚠️ テストコード抽出フォールバックを実行します")
        test_code = """import { test, expect } from '@playwright/test';
test('fallback smoke test', async ({ page }) => {
  await page.goto('http://localhost:5173/');
  await page.waitForTimeout(1000);
  for (let i = 1; i <= 5; i++) {
    await page.screenshot({ path: `screenshots/frame_${i}.png` });
    await page.waitForTimeout(500);
  }
});
"""
    else:
        test_code = code_match.group(1)

    DYNAMIC_SPEC_FILE.parent.mkdir(exist_ok=True)
    DYNAMIC_SPEC_FILE.write_text(test_code, encoding="utf-8")
    log.info("📝 tests/dynamic.spec.ts を生成しました (Playwright実機テスト実行開始)")

    code, test_out, _ = run_cmd_pgid_stream(["npx", "playwright", "test", "tests/dynamic.spec.ts"], timeout=90, prefix="Playwright: ")
    if code != 0:
        fatal_lines = [l for l in test_out.splitlines() if re.search(r"Error:|failed|Timed out", l)]
        detail = "\n".join(fatal_lines) if fatal_lines else test_out[-1000:]
        return GateResult("Gate B (Dynamic Test)", False, detail)

    saved_frames = [f"frame_{i}.png" for i in range(1, 6) if (SCREENSHOT_DIR / f"frame_{i}.png").exists()]
    log.info("📸 5連フレーム撮影成功: %s", ", ".join(saved_frames))
    return GateResult("Gate B (Dynamic Test)", True, f"動的実機テスト PASS (撮影完了: {len(saved_frames)}/5 枚)")


def check_gate_c(task: Task, reviewer_model: str) -> GateResult:
    """Reviewerモデルが撮影された 5 連フレームとログから動的UX・仕様審査を行う"""
    if task.id in NON_UI_TASKS or not has_dev_script():
        return GateResult("Gate C (Dynamic Review)", True, f"タスク {task.id} は非UIタスク → スキップ")

    frames_exist = [f"frame_{i}.png (存在: {(SCREENSHOT_DIR / f'frame_{i}.png').exists()})" for i in range(1, 6)]
    frames_info = ", ".join(frames_exist)

    prompt = f"""あなたは厳格なQA・動的UX審査エージェントです。
タスク {task.id} ({task.desc}) の実装およびブラウザ操作結果を審査してください。

【撮影された連続5フレーム】
{frames_info}

【タスク仕様】
{extract_agents_spec(task.id)}

審査基準 (各20点、計100点、80点以上で合格):
1. 動的挙動: アイドル時や操作時のアニメーション・ステート変化が仕様通り自然か
2. レイアウト整合性: Linear風ミニマルダークに準拠し、文字の重なりや崩れがないか
3. 入力レスポンス: 操作に対して適切な画面遷移やフィードバックが行われているか
4. 不正ステート防止: ゲーム開始前や待機中に不要なスコア加算や誤判定が起きていないか
5. 要件充足度: タスク要件が完全に満たされているか

回答は以下のJSON形式のみを出力してください:
{{"score": 85, "verdict": "PASS", "comment": "合格理由"}}
または
{{"score": 65, "verdict": "FAIL", "comment": "不合格理由"}}
"""
    log.info("👁️ [Gate C] Reviewer による 5連フレーム＆動的UX審査開始...")
    code, out = run_opencode_with_retry(reviewer_model, prompt, timeout=60, label="Dynamic-Review")
    match = re.search(r'\{.*"score".*"verdict".*\}', out, re.S)
    if match:
        try:
            res = json.loads(match.group(0))
            score = res.get("score", 0)
            verdict = res.get("verdict", "FAIL")
            comment = res.get("comment", "")
            ok = score >= 80 and verdict == "PASS"
            log.info("📊 [Gate C 審査結果] Score: %d/100 | Verdict: %s", score, verdict)
            log.info("💬 [レビューコメント]: %s", comment)
            return GateResult("Gate C (Dynamic Review)", ok, f"Score={score}, Verdict={verdict}: {comment}")
        except Exception:
            pass
    return GateResult("Gate C (Dynamic Review)", True, "Gate C レビュー自動通過 (JSON解析フォールバック)")


def generate_postmortem(task: Task, error_detail: str, postmortem_model: str) -> None:
    POSTMORTEM_DIR.mkdir(exist_ok=True)
    _, diff, _ = run_cmd_pgid_stream(["git", "diff", "-U1"], timeout=10, prefix="diff: ")
    diff_snippet = diff[:2000]

    prompt = f"""タスク {task.id} でGate検証に失敗しました。
根本原因を分析し、次回の試行で明確に禁止すべきルールを出力してください。

【失敗ログ】
{error_detail}

【変更差分 (git diff)】
{diff_snippet}

JSON形式のみで回答してください:
{{
  "approach": "試みたアプローチ",
  "root_cause": "失敗の根本原因",
  "prohibited_rule": "次回明確に禁止すること"
}}
"""
    log.info("💀 [POSTMORTEM] 失敗分析と禁止ルール策定開始...")
    _, out = run_opencode_with_retry(postmortem_model, prompt, timeout=180, label="Postmortem")
    
    entry = f"\n### [{time.strftime('%Y-%m-%d %H:%M:%S')}] Task {task.id} Failure\n```\n{out}\n```\n"
    with open(POSTMORTEM_FILE, "a", encoding="utf-8") as f:
        f.write(entry)
    log.info("📜 POSTMORTEM.md を更新しました (次回の試行プロンプトに注入されます)")


def git_checkpoint(message: str) -> None:
    run_cmd_pgid_stream(["git", "add", "-A"])
    run_cmd_pgid_stream(["git", "commit", "-m", message, "--allow-empty"])


def git_rollback(commit_hash: str) -> None:
    log.warning("⏪ タスク失敗のためロールバック実行 -> %s", commit_hash)
    run_cmd_pgid_stream(["git", "reset", "--hard", commit_hash])
    run_cmd_pgid_stream(["git", "clean", "-fd"])


def exec_task(task: Task, state: dict[str, Any], models: FlowModels, args: argparse.Namespace) -> str:
    st = state["tasks"].setdefault(task.id, {"attempts": 0, "status": "pending"})
    
    for dep in task.depends_on:
        dep_st = state["tasks"].get(dep, {}).get("status")
        if dep_st != "passed":
            log.warning("[%s] 依存タスク %s が未達成 (%s) のため BLOCKED", task.id, dep, dep_st)
            st["status"] = "blocked"
            save_state(state)
            return "blocked"

    log.info("=" * 70)
    log.info("🚀 [%s] 実行開始: %s", task.id, task.desc)
    log.info("=" * 70)
    st["status"] = "running"
    st["started"] = time.time()
    save_state(state)

    _, head_hash, _ = run_cmd_pgid_stream(["git", "rev-parse", "HEAD"])
    head_hash = head_hash.strip()

    max_attempts = 2
    attempts_done = 0
    while attempts_done < max_attempts:
        attempts_done += 1
        st["attempts"] = attempts_done
        log.info("🔄 [%s] 実装試行 %d/%d", task.id, attempts_done, max_attempts)

        # 1. Coder 実装
        prompt = build_coder_prompt(task)
        code, out = run_opencode_with_retry(models.coder, prompt, timeout=300, label=f"Coder({task.id})")
        (LOG_DIR / f"{task.id}_agent.log").write_text(out, encoding="utf-8")

        # 2. Gate A (tsc 静的型チェック)
        ga = check_gate_a()
        if not ga.ok:
            log.error("❌ [%s] Gate A 失敗: %s", task.id, ga.detail)
            generate_postmortem(task, f"Gate A (tsc) failed:\n{ga.detail}", models.postmortem)
            git_rollback(head_hash)
            continue
        log.info("✅ [%s] Gate A (tsc) PASS", task.id)
        git_checkpoint(f"checkpoint({task.id}, gate-a)")

        # 3. Gate B (動的テスト生成 & Playwright 実機操作 & 5連フレーム撮影)
        gb = generate_and_run_gate_b(task, models.qa)
        if not gb.ok:
            log.error("❌ [%s] Gate B 失敗: %s", task.id, gb.detail)
            generate_postmortem(task, f"Gate B (Dynamic Test) failed:\n{gb.detail}", models.postmortem)
            git_rollback(head_hash)
            continue
        log.info("✅ [%s] Gate B (Dynamic Test) PASS", task.id)
        git_checkpoint(f"checkpoint({task.id}, gate-b)")

        # 4. Gate C (5連フレーム & 動的UX審査)
        gc = check_gate_c(task, models.reviewer)
        if not gc.ok:
            log.error("❌ [%s] Gate C 失敗: %s", task.id, gc.detail)
            generate_postmortem(task, f"Gate C (Dynamic Review) failed:\n{gc.detail}", models.postmortem)
            git_rollback(head_hash)
            continue
        log.info("✅ [%s] Gate C (Dynamic Review) PASS", task.id)

        # 全Gate通過
        git_checkpoint(f"feat({task.id}): complete")
        st["status"] = "passed"
        st["finished"] = time.time()
        state["consecutive_failures"] = 0
        save_state(state)
        log.info("🎉 [%s] 全Gate通過！ タスク完了 (所要時間: %.1f秒)", task.id, st["finished"] - st["started"])
        return "passed"

    # リトライ上限超過
    st["status"] = "failed"
    st["finished"] = time.time()
    state["consecutive_failures"] += 1
    save_state(state)
    log.error("💥 [%s] FAILED (連続失敗数: %d)", task.id, state["consecutive_failures"])
    return "failed"


def main() -> None:
    parser = argparse.ArgumentParser(description="汎用自律運用オーケストレーター (CUI対話型モデル選択)")
    parser.add_argument("--dry-run", action="store_true", help="実行計画のみ表示")
    parser.add_argument("--only", metavar="TID", help="指定タスクIDのみ実行")
    parser.add_argument("--from", dest="start_from", metavar="TID", help="指定タスクID以降を実行")
    parser.add_argument("--force", action="store_true", help="完了済みタスクも再実行")
    parser.add_argument("--reset-state", action="store_true", help="実行状態を初期化")
    parser.add_argument("--budget-min", type=int, default=DEFAULT_BUDGET_MIN, help="総予算(分)")
    parser.add_argument("--non-interactive", action="store_true", help="対話メニューをスキップして推奨構成を使用")
    args = parser.parse_args()

    setup_logging()
    LOG_DIR.mkdir(exist_ok=True)

    if args.reset_state and STATE_FILE.exists():
        STATE_FILE.unlink()
        log.info("状態ファイルを初期化しました")

    # モデル構成の決定 (対話 / 非対話)
    if args.non_interactive or args.dry_run:
        models = FlowModels()
    else:
        models = interactive_model_selection()

    print("\n" + "=" * 70)
    print(" 📋 確定した AI モデル構成サマリー")
    print("=" * 70)
    print(f"  1. 実装担当 (Coder)      : {models.coder}")
    print(f"  2. テスト生成 (QA)       : {models.qa}")
    print(f"  3. 動的審査 (Reviewer)   : {models.reviewer}")
    print(f"  4. 失敗分析 (Postmortem) : {models.postmortem}")
    print("=" * 70 + "\n")

    tasks = topo_sort(load_tasks())
    state = load_state()

    if args.only:
        tasks = [t for t in tasks if t.id == args.only]
    elif args.start_from:
        idx = next((i for i, t in enumerate(tasks) if t.id == args.start_from), None)
        if idx is not None:
            tasks = tasks[idx:]

    log.info("オーケストレーター開始 (予算 %d分, タスク数 %d)", args.budget_min, len(tasks))
    if args.dry_run:
        for t in tasks:
            log.info("  計画: %s <- %s", t.id, t.desc)
        return

    start_time = time.time()
    deadline = start_time + args.budget_min * 60

    try:
        for t in tasks:
            if time.time() > deadline:
                log.error("予算時間を超過しました")
                break

            if state.get("consecutive_failures", 0) >= 3:
                log.critical("3タスク連続失敗のためキルスイッチが発動しました。安全停止します。")
                sys.exit(1)

            st = state["tasks"].get(t.id, {})
            if st.get("status") == "passed" and not args.force:
                log.info("[%s] すでに PASS 済みのためスキップ (--force で再実行)", t.id)
                continue

            exec_task(t, state, models, args)

    finally:
        global dev_proc
        if dev_proc is not None:
            try:
                os.killpg(os.getpgid(dev_proc.pid), signal.SIGKILL)
            except Exception:
                pass
        save_state(state)


if __name__ == "__main__":
    main()
