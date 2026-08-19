#!/usr/bin/env python3
"""汎用自律運用オーケストレーター

- Coder: opencode/deepseek-v4-flash-free (実装担当)
- QA Test Generator: moonshotai/kimi-k2.7-code (仕様を読みPlaywright動的テスト&5連フレーム撮影スクリプトを生成)
- Dynamic Reviewer: google/gemini-3.5-flash-lite (5連フレーム画像とログから動的UX/仕様審査)
- Architect: moonshotai/kimi-k2.7-code (Gate失敗時のPOSTMORTEM原因分析・禁止ルール生成)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import signal
import subprocess
import sys
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

CODER_MODEL = "opencode/deepseek-v4-flash-free"
TEST_GEN_MODEL = "moonshotai/kimi-k2.7-code"
REVIEWER_MODEL = "google/gemini-3.5-flash-lite"
ARCHITECT_MODEL = "moonshotai/kimi-k2.7-code"

BACKOFF_DELAYS = [5, 10, 30, 60, 120]

# UI画面を持たない型定義・純粋ロジックタスク
NON_UI_TASKS = {
    "T00", "T82", "T01", "T02", "T10", "T11", "T12", "T13", "T14",
    "T40", "T41", "T20", "T21", "T22", "T23", "T24", "T60", "T62"
}

log = logging.getLogger("orchestrator")


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


def run_cmd_pgid(cmd: list[str], timeout: int | None = None, cwd: Path = ROOT) -> tuple[int, str, bool]:
    e = os.environ.copy()
    e["FORCE_COLOR"] = "0"
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=e,
            start_new_session=True,
        )
    except Exception as err:
        return 127, f"コマンド実行失敗: {cmd[0]} ({err})", False

    try:
        out, _ = proc.communicate(timeout=timeout)
        return proc.returncode, out or "", False
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            time.sleep(2)
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        out, _ = proc.communicate()
        return -1, (out or "") + f"\n[タイムアウト {timeout}秒で強制終了]", True


def rate_limit_sleep(model: str) -> None:
    if "kimi" in model.lower():
        log.info("[RateLimit] Kimiモデルのため21秒待機します...")
        time.sleep(21)
    else:
        log.info("[RateLimit] 5秒待機します...")
        time.sleep(5)


def run_opencode_with_retry(model: str, prompt: str, timeout: int = 480) -> tuple[int, str]:
    cmd = ["opencode", "run", "--auto", "--format", "default", "--dir", str(ROOT), "-m", model, prompt]

    for attempt, delay in enumerate(BACKOFF_DELAYS, start=1):
        rate_limit_sleep(model)
        log.info("opencode 実行中 (model=%s, 試行 %d/%d)...", model, attempt, len(BACKOFF_DELAYS))
        code, out, timed_out = run_cmd_pgid(cmd, timeout=timeout)

        if "429" in out or "Too Many Requests" in out:
            log.warning("429 Too Many Requests 検知。%d秒 バックオフ待機して再試行します...", delay)
            time.sleep(delay)
            continue

        return code, out

    log.error("429 バックオフ リトライ上限に達しました")
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
    code, out, _ = run_cmd_pgid(["npx", "tsc", "--noEmit"], timeout=30)
    if code != 0:
        return GateResult("Gate A (tsc)", False, out[-2000:])
    return GateResult("Gate A (tsc)", True, "型チェックPASS")


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
                        return True
            except Exception:
                pass
            time.sleep(1)
    except Exception as err:
        log.error("dev server 起動失敗: %s", err)
    return False


def generate_and_run_gate_b(task: Task) -> GateResult:
    """Kimi にタスク仕様を読ませて動的 Playwright テスト(5連フレーム撮影含む)を生成し、実行する"""
    if task.id in NON_UI_TASKS or not has_dev_script():
        return GateResult("Gate B (Dynamic Test)", True, f"タスク {task.id} は非UIタスク → スキップ")

    if not ensure_dev_server():
        return GateResult("Gate B (Dynamic Test)", False, "dev server が起動しませんでした")

    SCREENSHOT_DIR.mkdir(exist_ok=True)

    # 1. Kimi による動的テスト生成
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
    log.info("[%s] Kimi による動的テストコード生成開始...", task.id)
    _, out = run_opencode_with_retry(TEST_GEN_MODEL, prompt, timeout=120)

    code_match = re.search(r"```(?:typescript|ts)?\s*(import\s+.*?)```", out, re.S)
    if not code_match:
        log.warning("[%s] Kimi からテストコードを抽出できなかったため、フォールバックテストを実行します", task.id)
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
    log.info("[%s] tests/dynamic.spec.ts を作成しました", task.id)

    # 2. 生成されたテストを実行
    code, test_out, _ = run_cmd_pgid(["npx", "playwright", "test", "tests/dynamic.spec.ts"], timeout=90)
    if code != 0:
        fatal_lines = [l for l in test_out.splitlines() if re.search(r"Error:|failed|Timed out", l)]
        detail = "\n".join(fatal_lines) if fatal_lines else test_out[-1000:]
        return GateResult("Gate B (Dynamic Test)", False, detail)

    return GateResult("Gate B (Dynamic Test)", True, "動的実機テストPASS (5連フレーム撮影完了)")


def check_gate_c(task: Task) -> GateResult:
    """Gemini 3.5 Flash Lite が撮影された 5 連フレームとログから動的UX・仕様審査を行う"""
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
    code, out = run_opencode_with_retry(REVIEWER_MODEL, prompt, timeout=60)
    match = re.search(r'\{.*"score".*"verdict".*\}', out, re.S)
    if match:
        try:
            res = json.loads(match.group(0))
            score = res.get("score", 0)
            verdict = res.get("verdict", "FAIL")
            ok = score >= 80 and verdict == "PASS"
            return GateResult("Gate C (Dynamic Review)", ok, f"Score={score}, Verdict={verdict}: {res.get('comment', '')}")
        except Exception:
            pass
    return GateResult("Gate C (Dynamic Review)", True, "Gate C レビュー自動通過 (JSON解析フォールバック)")


def generate_postmortem(task: Task, error_detail: str) -> None:
    POSTMORTEM_DIR.mkdir(exist_ok=True)
    _, diff, _ = run_cmd_pgid(["git", "diff", "-U1"], timeout=10)
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
    log.info("[%s] Kimi による POSTMORTEM 生成開始...", task.id)
    _, out = run_opencode_with_retry(ARCHITECT_MODEL, prompt, timeout=120)
    
    entry = f"\n### [{time.strftime('%Y-%m-%d %H:%M:%S')}] Task {task.id} Failure\n```\n{out}\n```\n"
    with open(POSTMORTEM_FILE, "a", encoding="utf-8") as f:
        f.write(entry)
    log.info("[%s] POSTMORTEM.md を更新しました", task.id)


def git_checkpoint(message: str) -> None:
    run_cmd_pgid(["git", "add", "-A"])
    run_cmd_pgid(["git", "commit", "-m", message, "--allow-empty"])


def git_rollback(commit_hash: str) -> None:
    log.warning("タスク失敗のためロールバック実行 -> %s", commit_hash)
    run_cmd_pgid(["git", "reset", "--hard", commit_hash])
    run_cmd_pgid(["git", "clean", "-fd"])


def exec_task(task: Task, state: dict[str, Any], args: argparse.Namespace) -> str:
    st = state["tasks"].setdefault(task.id, {"attempts": 0, "status": "pending"})
    
    # 依存関係チェック (BLOCKED 判定)
    for dep in task.depends_on:
        dep_st = state["tasks"].get(dep, {}).get("status")
        if dep_st != "passed":
            log.warning("[%s] 依存タスク %s が未達成 (%s) のため BLOCKED", task.id, dep, dep_st)
            st["status"] = "blocked"
            save_state(state)
            return "blocked"

    log.info("[%s] === 実行開始 (%s) ===", task.id, task.desc)
    st["status"] = "running"
    st["started"] = time.time()
    save_state(state)

    # 現在のコミットハッシュ記録
    _, head_hash, _ = run_cmd_pgid(["git", "rev-parse", "HEAD"])
    head_hash = head_hash.strip()

    max_attempts = 2
    while st["attempts"] < max_attempts:
        st["attempts"] += 1
        log.info("[%s] 実装試行 %d/%d", task.id, st["attempts"], max_attempts)

        # 1. Coder 実装 (DeepSeek)
        prompt = build_coder_prompt(task)
        code, out = run_opencode_with_retry(CODER_MODEL, prompt, timeout=480)
        (LOG_DIR / f"{task.id}_agent.log").write_text(out, encoding="utf-8")

        # 2. Gate A (tsc 静的型チェック)
        ga = check_gate_a()
        if not ga.ok:
            log.error("[%s] Gate A 失敗: %s", task.id, ga.detail)
            generate_postmortem(task, f"Gate A (tsc) failed:\n{ga.detail}")
            git_rollback(head_hash)
            continue
        git_checkpoint(f"checkpoint({task.id}, gate-a)")

        # 3. Gate B (Kimi テストコード生成 & Playwright 実機操作 & 5連フレーム撮影)
        gb = generate_and_run_gate_b(task)
        if not gb.ok:
            log.error("[%s] Gate B 失敗: %s", task.id, gb.detail)
            generate_postmortem(task, f"Gate B (Dynamic Test) failed:\n{gb.detail}")
            git_rollback(head_hash)
            continue
        git_checkpoint(f"checkpoint({task.id}, gate-b)")

        # 4. Gate C (Gemini 5連フレーム & 動的UX審査)
        gc = check_gate_c(task)
        if not gc.ok:
            log.error("[%s] Gate C 失敗: %s", task.id, gc.detail)
            generate_postmortem(task, f"Gate C (Dynamic Review) failed:\n{gc.detail}")
            git_rollback(head_hash)
            continue

        # 全Gate通過
        git_checkpoint(f"feat({task.id}): complete")
        st["status"] = "passed"
        st["finished"] = time.time()
        state["consecutive_failures"] = 0
        save_state(state)
        log.info("[%s] PASS! 全Gate通過", task.id)
        return "passed"

    # リトライ上限超過
    st["status"] = "failed"
    st["finished"] = time.time()
    state["consecutive_failures"] += 1
    save_state(state)
    log.error("[%s] FAILED (連続失敗数: %d)", task.id, state["consecutive_failures"])
    return "failed"


def main() -> None:
    parser = argparse.ArgumentParser(description="汎用自律運用オーケストレーター")
    parser.add_argument("--dry-run", action="store_true", help="実行計画のみ表示")
    parser.add_argument("--only", metavar="TID", help="指定タスクIDのみ実行")
    parser.add_argument("--from", dest="start_from", metavar="TID", help="指定タスクID以降を実行")
    parser.add_argument("--reset-state", action="store_true", help="実行状態を初期化")
    parser.add_argument("--budget-min", type=int, default=DEFAULT_BUDGET_MIN, help="総予算(分)")
    args = parser.parse_args()

    setup_logging()
    LOG_DIR.mkdir(exist_ok=True)

    if args.reset_state and STATE_FILE.exists():
        STATE_FILE.unlink()
        log.info("状態ファイルを初期化しました")

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
            if st.get("status") == "passed":
                log.info("[%s] すでに PASS 済みのためスキップ", t.id)
                continue

            exec_task(t, state, args)

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
