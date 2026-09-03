#!/usr/bin/env python3
"""汎用自律運用オーケストレーター (Linear風ミニマル・モダンCLI)

- Coder / QA / Postmortem の高速枠を Laguna S 2.1 Free に刷新
- Dynamic Reviewer の選択肢を洗練された2モデルに集約
- 区間指定実行 (--from TID --to TID) & 依存関係の自動検証・解決
- 審査エラー/タイムアウト時の勝手な自動PASSを完全廃止 (厳格Gate検証)
- 絵文字完全排除 & ANSIカラーによる洗練されたモダンUI
- 起動前ヘルスチェック（残高・APIキー・疎通）
- CUI 対話型モデル選択システム (Coder / QA / Reviewer / Postmortem)
- 超軽量トークン最適化 (入力サイズ約85%削減)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import queue
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ANSI カラーパレット (Linear風)
RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
GRAY = "\033[90m"

CYAN = "\033[38;2;34;211;238m"
INDIGO = "\033[38;2;99;102;241m"
GREEN = "\033[38;2;74;222;128m"
YELLOW = "\033[38;2;251;191;36m"
RED = "\033[38;2;248;113;113m"

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
DYNAMIC_TEST_FILE = ROOT / "tests" / "dynamic.test.ts"

DEV_URL = os.environ.get("DEV_URL", "http://127.0.0.1:5173/")
DEFAULT_BUDGET_MIN = 600

# テストランナー実行タイムアウト（秒）。ハング（タイムアウト）時にQAテストを再生成するための上限。
PW_RED_TIMEOUT = 150
PW_GREEN_TIMEOUT = 180


def _test_runner(args: argparse.Namespace | None) -> str:
    """現在のテストランナーを返す（デフォルト vitest）。"""
    if args is None:
        return "vitest"
    return getattr(args, "test_runner", "vitest") or "vitest"


def _dynamic_test_file(tr: str) -> Path:
    """テストランナーに応じた動的テストファイルパスを返す。"""
    return DYNAMIC_TEST_FILE if tr == "vitest" else DYNAMIC_SPEC_FILE


def _qa_test_filename(tr: str) -> str:
    """QAに生成させるテストファイル名（vitest=dynamic.test.ts / playwright=dynamic.spec.ts）。"""
    return "dynamic.test.ts" if tr == "vitest" else "dynamic.spec.ts"

# モデル定義カタログ (表示名, プロバイダ, モデルID)
MODEL_CATALOG = {
    "big_pickle": ("Big Pickle", "OpenCode Zen", "opencode/big-pickle"),
    "nemotron_ultra": ("Nemotron 3 Ultra", "OpenCode Zen (Free)", "opencode/nemotron-3-ultra-free"),
    "muse_spark": ("Muse Spark 1.2 Contributor", "OpenCode Zen (Free)", "opencode/muse-spark-1.2-contributor-free"),
    "gemini_flash_lite": ("Gemini 3.5 Flash-Lite", "Google AI Studio", "google/gemini-3.5-flash-lite"),
    "gemini_flash_3_1_lite": ("Gemini 3.1 Flash-Lite", "Google AI Studio", "google/gemini-3.1-flash-lite"),
}

CODER_OPTIONS = [
    ("big_pickle", "[OpenCode Zen] Big Pickle", "Rank 1: 高精度コード生成 (Default)"),
    ("muse_spark", "[OpenCode Zen] Muse Spark 1.2 Contributor", "自律枠: 完全無料・自律コード生成"),
    ("gemini_flash_lite", "[Google] Gemini 3.5 Flash-Lite", "爆速枠: 待ち時間最小・超安定"),
    ("gemini_flash_3_1_lite", "[Google] Gemini 3.1 Flash-Lite", "爆速枠: 待ち時間最小・超安定"),
]

QA_OPTIONS = [
    ("nemotron_ultra", "[OpenCode Zen] Nemotron 3 Ultra", "Rank 1: 論理的テストケース網羅・動画テスト生成"),
    ("muse_spark", "[OpenCode Zen] Muse Spark 1.2 Contributor", "自律枠: 完全無料・自律動画テスト生成"),
    ("gemini_flash_lite", "[Google] Gemini 3.5 Flash-Lite", "爆速枠: 即時動画テスト生成"),
    ("gemini_flash_3_1_lite", "[Google] Gemini 3.1 Flash-Lite", "爆速枠: 即時動画テスト生成"),
]

REVIEWER_OPTIONS = [
    ("gemini_flash_lite", "[Google] Gemini 3.5 Flash-Lite", "コードレビュー: 高精度審査"),
    ("nemotron_ultra", "[OpenCode Zen] Nemotron 3 Ultra", "コードレビュー: 推論特化"),
    ("gemini_flash_3_1_lite", "[Google] Gemini 3.1 Flash-Lite", "コードレビュー: 動画審査"),
    ("muse_spark", "[OpenCode Zen] Muse Spark 1.2 Contributor", "自律枠: 完全無料・自律コードレビュー"),
]

POSTMORTEM_OPTIONS = [
    ("nemotron_ultra", "[OpenCode Zen] Nemotron 3 Ultra", "Rank 1: 推論特化・根本原因究明"),
    ("muse_spark", "[OpenCode Zen] Muse Spark 1.2 Contributor", "自律枠: 完全無料・自律原因分析"),
    ("gemini_flash_lite", "[Google] Gemini 3.5 Flash-Lite", "爆速枠: 即時エラー要約"),
]

BACKOFF_DELAYS = [5, 10, 30, 60, 120]

log = logging.getLogger("orchestrator")


def resolve_model_id(val: str) -> str:
    """Resolve a catalog short-key or full model ID."""
    if not val:
        return ""
    if val in MODEL_CATALOG:
        return MODEL_CATALOG[val][2]
    for key, (name, provider, mid) in MODEL_CATALOG.items():
        if val.lower() == mid.lower() or val.lower() == key.lower():
            return mid
    return val


@dataclass
class FlowModels:
    coder: str = MODEL_CATALOG["big_pickle"][2]
    qa: str = MODEL_CATALOG["muse_spark"][2]
    reviewer: str = MODEL_CATALOG["gemini_flash_lite"][2]
    postmortem: str = MODEL_CATALOG["nemotron_ultra"][2]

    def to_dict(self) -> dict[str, str]:
        return {
            "coder": self.coder,
            "qa": self.qa,
            "reviewer": self.reviewer,
            "postmortem": self.postmortem,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "FlowModels":
        return cls(
            coder=resolve_model_id(data.get("coder", MODEL_CATALOG["big_pickle"][2])),
            qa=resolve_model_id(data.get("qa", MODEL_CATALOG["muse_spark"][2])),
            reviewer=resolve_model_id(data.get("reviewer", MODEL_CATALOG["gemini_flash_lite"][2])),
            postmortem=resolve_model_id(data.get("postmortem", MODEL_CATALOG["nemotron_ultra"][2])),
        )


@dataclass
class Task:
    id: str
    desc: str
    depends_on: list[str] = field(default_factory=list)
    test: bool = False
    task_type: str = "feature"


@dataclass
class GateResult:
    name: str
    ok: bool
    detail: str = ""
    fatal: bool = False


class ColoredFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        t = self.formatTime(record, "%H:%M:%S")
        if record.levelno >= logging.CRITICAL:
            lvl = f"{RED}{BOLD}[CRITICAL]{RESET}"
        elif record.levelno >= logging.ERROR:
            lvl = f"{RED}[ERROR]{RESET}"
        elif record.levelno >= logging.WARNING:
            lvl = f"{YELLOW}[WARN]{RESET}"
        else:
            lvl = f"{CYAN}[INFO]{RESET}"
        return f"{GRAY}{t}{RESET} {lvl} {record.getMessage()}"


def setup_logging() -> None:
    file_handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(ColoredFormatter())

    logging.basicConfig(level=logging.INFO, handlers=[file_handler, stream_handler])


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
        return 127, f"Command execution failed: {cmd[0]} ({err})", False

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
                print(f"  {GRAY}│{RESET} {prefix}{cleaned}", flush=True)
        except queue.Empty:
            pass

        if timeout and (time.time() - start_t > timeout):
            timed_out = True
            log.warning("Timeout reached (%ds). Terminating process.", timeout)
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                time.sleep(1)
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except ProcessLookupError:
                pass
            print(f"  {GRAY}└─{RESET} {YELLOW}[TIMEOUT: {timeout}s]{RESET}", flush=True)
            break

        if proc.poll() is not None and q.empty():
            break

    proc.wait()
    full_out = "".join(collected)
    return (proc.returncode if not timed_out else -1), full_out, timed_out


def check_model_health(model_id: str, label: str) -> bool:
    print(f"  {CYAN}Checking{RESET} {BOLD}{label}{RESET} ({GRAY}{model_id}{RESET})... ", end="", flush=True)
    # 推論モデル（R1系）は初回レスポンスが遅いためタイムアウトを延長
    timeout = 90 if "r1" in model_id.lower() or "reasoning" in model_id.lower() else 40

    title = "Preflight Health Check"
    session_id = None
    db_path = os.path.expanduser("~/.local/share/opencode/opencode.db")
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id FROM session WHERE title = ? AND directory = ? ORDER BY time_created DESC LIMIT 1",
            (title, str(ROOT))
        )
        row = cursor.fetchone()
        if row:
            session_id = row[0]
        conn.close()
    except Exception:
        pass

    cmd = ["opencode", "run", "--auto", "--format", "default", "--dir", str(ROOT), "-m", model_id]
    if session_id:
        cmd.extend(["-s", session_id])
    else:
        cmd.extend(["--title", title])
    cmd.extend(["--", "Say hello"])

    code, out, timed_out = run_cmd_pgid_stream(cmd, timeout=timeout, prefix="")

    if "insufficient balance" in out or "suspended" in out or "payment required" in out.lower() or "depleted your monthly included credits" in out.lower():
        print(f"{RED}[FAILED: Credits Depleted / Payment Required]{RESET}")
        print(f"\n{RED}{'!' * 70}{RESET}")
        print(f"  {RED}{BOLD}ERROR:{RESET} {label} ({model_id}) credits depleted or subscription expired.")
        print(f"  {GRAY}Details: {out.strip()}{RESET}")
        print(f"{RED}{'!' * 70}{RESET}\n")
        return False

    if "tokens per minute (TPM)" in out or "Request too large" in out:
        print(f"{RED}[FAILED: TPM Rate Limit Exceeded]{RESET}")
        print(f"\n{RED}{'!' * 70}{RESET}")
        print(f"  {RED}{BOLD}ERROR:{RESET} {label} ({model_id}) hit provider TPM limit.")
        print(f"  {GRAY}Details: {out.strip()}{RESET}")
        print(f"{RED}{'!' * 70}{RESET}\n")
        return False

    if "CLOUDFLARE_ACCOUNT_ID is missing" in out or "API_KEY" in out or "unauthorized" in out.lower():
        print(f"{RED}[FAILED: Missing Credentials]{RESET}")
        print(f"\n{RED}{'!' * 70}{RESET}")
        print(f"  {RED}{BOLD}ERROR:{RESET} {label} ({model_id}) missing required API key or Account ID.")
        print(f"  {GRAY}Details: {out.strip()}{RESET}")
        print(f"{RED}{'!' * 70}{RESET}\n")
        return False

    if "UnknownError" in out or "Unexpected server error" in out:
        print(f"{RED}[FAILED: Server-side Error]{RESET}")
        print(f"\n{RED}{'!' * 70}{RESET}")
        print(f"  {RED}{BOLD}ERROR:{RESET} {label} ({model_id}) returned UnknownError (provider server-side issue).")
        print(f"  {GRAY}Details: {out.strip()}{RESET}")
        print(f"{RED}{'!' * 70}{RESET}\n")
        return False

    if "ping" in out or code == 0 or "build" in out or "hello" in out.lower():
        print(f"{GREEN}[OK]{RESET}")
        return True

    if code != 0 or timed_out:
        print(f"{RED}[FAILED: No Response (exit={code})]{RESET}")
        return False

    print(f"{GREEN}[OK]{RESET}")
    return True


def perform_preflight_checks(models: FlowModels, code_review_only: bool = False) -> bool:
    print("\n" + f"{GRAY}─── Pre-flight Health Check ────────────────────────────────────────{RESET}")
    all_ok = True
    checked: set[str] = set()

    check_list = [("1. Coder", models.coder), ("3. Code Reviewer", models.reviewer), ("4. Postmortem", models.postmortem)]
    if not code_review_only:
        check_list.insert(1, ("2. QA", models.qa))

    for label, m in check_list:
        if not m:
            continue
        if m in checked:
            print(f"  {DIM}Verified{RESET} {BOLD}{label}{RESET} ({GRAY}{m}{RESET}) -> {GREEN}[OK]{RESET}")
            continue
        checked.add(m)
        ok = check_model_health(m, label)
        if not ok:
            all_ok = False

    print(f"{GRAY}────────────────────────────────────────────────────────────────────{RESET}")
    if not all_ok:
        print(f"{RED}Health check failed on one or more models.{RESET}")
        cont = input(f"Continue anyway? ({BOLD}y/N{RESET}): ").strip().lower()
        return cont == "y"
    
    print(f"{GREEN}All model connections verified successfully.{RESET}\n")
    return True


def get_model_display(model_id: str) -> str:
    for _, (name, provider, mid) in MODEL_CATALOG.items():
        if mid == model_id:
            return f"{GRAY}[{provider}]{RESET} {name}"
    return f"{model_id}"


def interactive_model_selection(code_review_only: bool = False) -> FlowModels:
    print("\n" + f"{INDIGO}{BOLD}TRACE WAVE // Autonomous Orchestrator{RESET}")
    print(f"{GRAY}────────────────────────────────────────────────────────────────────{RESET}")
    
    if code_review_only:
        print(f"  {BOLD}[1]{RESET} {GREEN}Recommended Preset (Code Review Only){RESET}")
        print(f"      {GRAY}├─ 1. Coder      :{RESET} {GRAY}[OpenCode Zen]{RESET} {CYAN}Big Pickle{RESET}")
        print(f"      {GRAY}├─ 2. Code Reviewer:{RESET} {GRAY}[Google]{RESET} {CYAN}Gemini 3.5 Flash-Lite{RESET}")
        print(f"      {GRAY}└─ 3. Postmortem :{RESET} {GRAY}[OpenCode Zen]{RESET} {CYAN}Nemotron 3 Ultra{RESET}")
        print(f"  {BOLD}[2]{RESET} {YELLOW}Ultra-Fast Preset{RESET} (Gemini 3.5 Flash-Lite Unified) {GRAY}[Google]{RESET}")
        print(f"  {BOLD}[3]{RESET} {DIM}Custom Configuration{RESET} (Select each model manually)")
    else:
        print(f"  {BOLD}[1]{RESET} {GREEN}Recommended Preset{RESET} (Rank 1 Models)")
        print(f"      {GRAY}├─ 1. Coder      :{RESET} {GRAY}[OpenCode Zen]{RESET} {CYAN}Big Pickle{RESET}")
        print(f"      {GRAY}├─ 2. QA Test    :{RESET} {GRAY}[OpenCode Zen]{RESET} {CYAN}Muse Spark 1.2 Contributor{RESET}")
        print(f"      {GRAY}├─ 3. Code Review:{RESET} {GRAY}[Google]{RESET} {CYAN}Gemini 3.5 Flash-Lite{RESET}")
        print(f"      {GRAY}└─ 4. Postmortem :{RESET} {GRAY}[OpenCode Zen]{RESET} {CYAN}Nemotron 3 Ultra{RESET}")
        print(f"  {BOLD}[2]{RESET} {YELLOW}Ultra-Fast Preset{RESET} (Gemini 3.5 Flash-Lite Unified) {GRAY}[Google]{RESET}")
        print(f"  {BOLD}[3]{RESET} {DIM}Custom Configuration{RESET} (Select each model manually)")
    print(f"{GRAY}────────────────────────────────────────────────────────────────────{RESET}")

    choice = input(f"Select preset [{BOLD}1{RESET}]: ").strip()

    if choice == "" or choice == "1":
        print(f"{GREEN}>> Applied: Recommended Preset{RESET}")
        if code_review_only:
            return FlowModels(
                coder=MODEL_CATALOG["big_pickle"][2],
                qa=MODEL_CATALOG["gemini_flash_lite"][2],
                reviewer=MODEL_CATALOG["gemini_flash_lite"][2],
                postmortem=MODEL_CATALOG["nemotron_ultra"][2],
            )
        else:
            return FlowModels(
                coder=MODEL_CATALOG["big_pickle"][2],
                qa=MODEL_CATALOG["muse_spark"][2],
                reviewer=MODEL_CATALOG["gemini_flash_lite"][2],
                postmortem=MODEL_CATALOG["nemotron_ultra"][2],
            )
    elif choice == "2":
        print(f"{YELLOW}>> Applied: Ultra-Fast Preset (Gemini Unified){RESET}")
        return FlowModels(
            coder=MODEL_CATALOG["gemini_flash_lite"][2],
            qa=MODEL_CATALOG["gemini_flash_lite"][2],
            reviewer=MODEL_CATALOG["gemini_flash_lite"][2],
            postmortem=MODEL_CATALOG["gemini_flash_lite"][2],
        )

    def select_one(title: str, options: list[tuple[str, str, str]], default_key: str) -> str:
        print(f"\n{INDIGO}{BOLD}{title}{RESET}")
        for i, (key, name, desc) in enumerate(options, 1):
            mark = f" {GREEN}(Default){RESET}" if key == default_key else ""
            print(f"  {BOLD}[{i}]{RESET} {CYAN}{name:<32}{RESET} {GRAY}│{RESET} {desc}{mark}")
        ans = input(f"Enter choice [1-{len(options)}, default: Enter]: ").strip()
        selected_key = default_key
        if ans:
            try:
                idx = int(ans) - 1
                if 0 <= idx < len(options):
                    selected_key = options[idx][0]
            except Exception:
                pass

        return MODEL_CATALOG[selected_key][2]

    coder_m = select_one("Select [1. Coder]:", CODER_OPTIONS, "big_pickle")
    
    if code_review_only:
        # QAは不要なため空文字を設定
        qa_m = "" 
        rev_m = select_one("Select [2. Code Reviewer]:", REVIEWER_OPTIONS, "gemini_flash_lite")
        post_m = select_one("Select [3. Postmortem Architect]:", POSTMORTEM_OPTIONS, "nemotron_ultra")
    else:
        qa_m = select_one("Select [2. QA Test Generator]:", QA_OPTIONS, "muse_spark")
        rev_m = select_one("Select [3. Code Reviewer]:", REVIEWER_OPTIONS, "gemini_flash_lite")
        post_m = select_one("Select [4. Postmortem Architect]:", POSTMORTEM_OPTIONS, "nemotron_ultra")

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
        tasks.append(Task(
            id=tid,
            desc=item.get("desc", ""),
            depends_on=item.get("depends_on", []),
            test=bool(item.get("test", False)),
            task_type=str(item.get("type", "feature")),
        ))
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


def get_task_ancestors(tasks_by_id: dict[str, Task], target_ids: list[str]) -> set[str]:
    ancestors: set[str] = set()

    def dfs(tid: str) -> None:
        if tid in ancestors or tid not in tasks_by_id:
            return
        ancestors.add(tid)
        for dep in tasks_by_id[tid].depends_on:
            dfs(dep)

    for tid in target_ids:
        dfs(tid)
    return ancestors


def load_state() -> dict[str, Any]:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"started_at": time.time(), "tasks": {}, "consecutive_no_action": 0}


def save_state(state: dict[str, Any]) -> None:
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def rate_limit_sleep(model: str) -> None:
    if "kimi" in model.lower():
        log.info("RateLimit sleep: 21s (Kimi)...")
        time.sleep(21)
    else:
        log.info("RateLimit sleep: 5s...")
        time.sleep(5)


def run_opencode_with_retry(
    model: str,
    prompt: str,
    timeout: int | None = None,
    label: str = "OpenCode",
    variant: str | None = None,
    files: list[str] | None = None,
    task_id: str | None = None,
    role: str | None = None,
    state: dict[str, Any] | None = None,
    fresh_sessions: bool = False,
    title: str | None = None,
) -> tuple[int, str]:
    session_id = None
    title = title or None
    if task_id and role and state is not None:
        title = title or f"[{task_id}] {role.capitalize()}"
        task_st = state.setdefault("tasks", {}).setdefault(task_id, {})
        sessions = task_st.setdefault("sessions", {})
        session_id = sessions.get(role)

        db_path = os.path.expanduser("~/.local/share/opencode/opencode.db")
        if session_id:
            try:
                conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
                cursor = conn.cursor()
                cursor.execute("SELECT id FROM session WHERE id = ?", (session_id,))
                if not cursor.fetchone():
                    session_id = None
                conn.close()
            except Exception:
                session_id = None

        if not session_id and title and not fresh_sessions:
            try:
                conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT id FROM session WHERE title = ? AND directory = ? ORDER BY time_created DESC LIMIT 1",
                    (title, str(ROOT))
                )
                row = cursor.fetchone()
                if row:
                    session_id = row[0]
                conn.close()
            except Exception:
                pass

    cmd = ["opencode", "run", "--auto", "--format", "default", "--dir", str(ROOT), "-m", model]
    if session_id:
        cmd.extend(["-s", session_id])
    elif title:
        cmd.extend(["--title", title])

    if variant:
        cmd.extend(["--variant", variant])
    if files:
        for f in files:
            cmd.extend(["-f", f])
    cmd.extend(["--", prompt])

    for attempt, delay in enumerate(BACKOFF_DELAYS, start=1):
        rate_limit_sleep(model)
        variant_info = f", variant={variant}" if variant else ""
        timeout_disp = f"{timeout}s" if timeout else "∞"
        session_info = f" (session={session_id})" if session_id else (f" (title={title})" if title else "")
        log.info("Dispatching %s%s%s (model=%s%s%s%s, attempt=%d/%d, timeout=%s)%s", BOLD, label, RESET, GRAY, model, variant_info, RESET, attempt, len(BACKOFF_DELAYS), timeout_disp, session_info)
        print(f"  {GRAY}┌─ Start: {label} ──────────────────────────────────────{RESET}", flush=True)
        code, out, timed_out = run_cmd_pgid_stream(cmd, timeout=timeout, prefix=f"{CYAN}::{RESET} ")
        print(f"  {GRAY}└─ End: {label} (exit={code}) ─────────────────────────────────{RESET}", flush=True)

        if task_id and role and state is not None and not session_id and title:
            try:
                db_path = os.path.expanduser("~/.local/share/opencode/opencode.db")
                conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT id FROM session WHERE title = ? AND directory = ? ORDER BY time_created DESC LIMIT 1",
                    (title, str(ROOT))
                )
                row = cursor.fetchone()
                if row:
                    session_id = row[0]
                    task_st = state.setdefault("tasks", {}).setdefault(task_id, {})
                    task_st.setdefault("sessions", {})[role] = session_id
                    save_state(state)
                    log.info("Persisted session %s for task=%s, role=%s", session_id, task_id, role)
                conn.close()
            except Exception as e:
                log.debug("Failed to fetch newly created session_id: %s", e)

        if "insufficient balance" in out or "suspended" in out:
            print(f"\n{RED}{BOLD}[CRITICAL] Account suspended due to insufficient balance on {model}{RESET}\n")
            return -1, out

        if timed_out:
            if out.strip() != "":
                log.info("Process timed out but produced non-empty output (acted). Accepting partial output and continuing.")
                return 0, out
            log.warning("Process timed out with empty output (%ds). Retrying...", timeout)
            continue

        if "429" in out or "Too Many Requests" in out or "Rate limit exceeded" in out:
            log.warning("Rate limit exceeded. Backoff %ds...", delay)
            time.sleep(delay)
            continue

        return code, out

    if out.strip() != "":
        return 0, out

    log.error("Retry limit exceeded for %s (empty output)", label)
    return -1, out


def extract_compact_spec(task_id: str) -> str:
    if AGENTS_MD.exists():
        text = AGENTS_MD.read_text(encoding="utf-8")
        pattern = rf"### \[?{task_id}\]?.*?(?=\n### \[?T\d+\]?|\n## |\Z)"
        match = re.search(pattern, text, re.S)
        if match:
            return match.group(0).strip()
    if TASKS_JSON.exists():
        try:
            tasks_data = json.loads(TASKS_JSON.read_text(encoding="utf-8"))
            for item in tasks_data:
                if item.get("id") == task_id:
                    desc = item.get("desc", "")
                    deps = item.get("depends_on", [])
                    return f"Task {task_id}: {desc}\nDependencies: {deps}"
        except Exception:
            pass
    return f"Task {task_id} specification"


def get_task_context_path(task_id: str) -> Path:
    POSTMORTEM_DIR.mkdir(exist_ok=True)
    return POSTMORTEM_DIR / f"context_{task_id}.json"


def load_task_context(task_id: str) -> dict[str, Any]:
    path = get_task_context_path(task_id)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "task_id": task_id,
        "implemented_ui": {
            "ids": [],
            "test_ids": [],
            "files_changed": []
        },
        "last_failure": {
            "error_summary": ""
        },
        "fix_hints": [],
        "prohibited_rules": []
    }


def save_task_context(task_id: str, context: dict[str, Any]) -> None:
    path = get_task_context_path(task_id)
    try:
        path.write_text(json.dumps(context, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        log.warning("[%s] Failed to save task context: %s", task_id, e)


def extract_implemented_ui(task_id: str) -> dict[str, Any]:
    """Extract actual DOM IDs, data-testids, and changed files to prevent QA hallucinations."""
    ids: set[str] = set()
    test_ids: set[str] = set()
    files_changed: list[str] = []

    # Get changed files from git diff if possible
    code, out, _ = run_cmd_pgid_stream(["git", "diff", "--name-only", "HEAD~1", "HEAD"])
    if code == 0 and out.strip():
        files_changed = [
            f.strip() for f in out.splitlines()
            if f.strip().startswith("src/") and f.strip().endswith((".tsx", ".ts"))
        ]

    # Scan relevant tsx/ts files for id and data-testid
    scan_targets = [ROOT / f for f in files_changed] if files_changed else list((ROOT / "src").glob("**/*.tsx"))
    for fpath in scan_targets:
        if fpath.exists():
            try:
                content = fpath.read_text(encoding="utf-8")
                # Match id="..." (excluding dynamic expressions)
                for m in re.findall(r'\bid=["\']([a-zA-Z0-9_-]+)["\']', content):
                    if m not in ("root",):
                        ids.add(m)
                # Match data-testid="..."
                for m in re.findall(r'data-testid=["\']([a-zA-Z0-9_-]+)["\']', content):
                    test_ids.add(m)
            except Exception:
                pass

    return {
        "ids": sorted(list(ids)),
        "test_ids": sorted(list(test_ids)),
        "files_changed": files_changed,
    }


def get_task_context_prompt_for_qa(task_id: str) -> str:
    ctx = load_task_context(task_id)
    ui = ctx.get("implemented_ui", {})
    fix_hints = ctx.get("fix_hints", [])

    parts = []
    if ui.get("ids") or ui.get("test_ids") or ui.get("files_changed"):
        parts.append("【Actual Implemented UI Elements (from Codebase)】:")
        if ui.get("files_changed"):
            parts.append(f"- Files Modified: {', '.join(ui['files_changed'])}")
        if ui.get("test_ids"):
            parts.append(f"- Available data-testid: {', '.join(f'[data-testid=\"{t}\"]' for t in ui['test_ids'])}")
        if ui.get("ids"):
            parts.append(f"- Available IDs: {', '.join(f'#{i}' for i in ui['ids'])}")
        parts.append("- CRITICAL: Do NOT hallucinate or guess non-existent parent container IDs (e.g. #music-control, #bpm-editor, etc.). Use the available data-testid, IDs, or text selectors listed above.")

    if fix_hints:
        parts.append("\n【Actionable Fix Prescriptions (from Postmortem)】:")
        for hint in fix_hints[-3:]:
            parts.append(f"- {hint}")

    return "\n".join(parts) + "\n" if parts else ""


def get_task_context_prompt_for_coder(task_id: str) -> str:
    ctx = load_task_context(task_id)
    fix_hints = ctx.get("fix_hints", [])
    last_fail = ctx.get("last_failure", {}).get("error_summary", "")

    parts = []
    if last_fail:
        parts.append("【Previous Failure Summary】:")
        parts.append(f"- {last_fail[:400]}")

    if fix_hints:
        parts.append("\n【Actionable Fix Prescriptions (from Postmortem)】:")
        for hint in fix_hints[-3:]:
            parts.append(f"- {hint}")

    return "\n".join(parts) + "\n" if parts else ""


def get_recent_postmortem_rules() -> str:
    if POSTMORTEM_FILE.exists():
        pm_text = POSTMORTEM_FILE.read_text(encoding="utf-8")
        matches = re.findall(r'"prohibited_rule":\s*"([^"]+)"', pm_text)
        if matches:
            return "\n【Prohibited Rules from Past Failures】:\n" + "\n".join(f"- {r}" for r in matches[-3:])
    return ""


def build_compact_coder_prompt(task: Task, debug_mode: bool = False) -> str:
    spec = extract_compact_spec(task.id)
    recent_rules = get_recent_postmortem_rules()
    context_hints = get_task_context_prompt_for_coder(task.id)
    
    debug_instructions = ""
    if debug_mode:
        debug_instructions = """
- DEBUG MODE ACTIVE: Inject console.log() statements into the source code to observe variables (especially segment generation and amplitude calculations) during execution.
- Only log relevant state changes or calculation inputs/outputs.
- REMOVE all console.log() statements once debugging is complete and the task is passing."""

    return f"""Implement the following task. No questions allowed.

Task: {task.id} - {task.desc}

Specification:
{spec}
{recent_rules}
{context_hints}

Constraints:
- STRICTLY use the `edit` tool for all code modifications.
- NEVER output full file contents in your response. Only output the specific changes using the `edit` tool.
- Ensure zero TypeScript compiler errors (`tsc --noEmit`).
- Do NOT run Playwright tests or browser tests (npx playwright test). Rely solely on tsc for static verification.
- Strict minimal dark theme (Linear/Vercel style). No gaming/RGB glows.
- Output 'DONE' upon completion.
{debug_instructions}
"""


def check_gate_a() -> GateResult:
    tsconfig = ROOT / "tsconfig.json"
    if not tsconfig.exists():
        return GateResult("Gate A (tsc)", True, "No tsconfig.json -> Skip")
    log.info("Checking TypeScript static types (`tsc -b --noEmit`)...")
    code, out, _ = run_cmd_pgid_stream(["npx", "tsc", "-b", "--noEmit"], timeout=None, prefix="tsc: ")
    if code != 0:
        return GateResult("Gate A (tsc)", False, out[-2000:])
    return GateResult("Gate A (tsc)", True, "0 errors found")


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
        log.info("Starting Vite dev server (%s)...", DEV_URL)
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
                        log.info("Vite dev server ready.")
                        return True
            except Exception:
                pass
            time.sleep(1)
    except Exception as err:
        log.error("Failed to start dev server: %s", err)
    return False


VIDEO_DIR = ROOT / "recordings"


def generate_qa_test(task: Task, qa_model: str, state: dict[str, Any] | None = None, fresh_sessions: bool = False, test_runner: str = "vitest") -> bool:
    """TDD pipeline: QA-Gen writes the dynamic test from the specification (no execution).

    Returns True if the test file was actually written. The test is expected to FAIL (Red)
    before implementation exists; the caller is responsible for the Red verification.
    """
    if not task.test or not has_dev_script():
        return False
    if not ensure_dev_server():
        return False

    SCREENSHOT_DIR.mkdir(exist_ok=True)
    VIDEO_DIR.mkdir(exist_ok=True)
    spec = extract_compact_spec(task.id)
    recent_rules = get_recent_postmortem_rules()
    context_hints = get_task_context_prompt_for_qa(task.id)

    test_filename = _qa_test_filename(test_runner)
    test_file: Path = _dynamic_test_file(test_runner)

    if state and task.id in state.get("tasks", {}):
        state["tasks"][task.id].setdefault("sessions", {})["qa"] = None
    qa_title = f"[{task.id}] Qa {uuid.uuid4().hex[:8]}"

    task_type_guidance = ""
    if task.task_type in ("negative", "removal"):
        task_type_guidance = f"""
NEGATIVE/REMOVAL TASK PROTOCOL (Task Type: {task.task_type}):
- This task ({task.id}) removes or disables a legacy feature (e.g. key presses in playback mode must not create segments).
- You MUST test BOTH:
  (a) Positive Control: In the valid mode (e.g. record mode), key actions DO create/modify trajectories/segments.
  (b) Negative Control: In the disabled mode (e.g. playback mode), the exact same key actions do NOT modify segments.
- Make sure positive controls verify genuine behavior so that tests do NOT trivially pass on un-implemented/stub code.
"""

    if test_runner == "vitest":
        runner_intro = (
            f"Write a thorough Vitest (TypeScript, node environment) unit test module for task {task.id} ({task.desc}), "
            f"and save it DIRECTLY to `tests/{test_filename}` using your file-write tool.\n\n"
            "This runs WITHOUT a browser: directly `import` the small focused modules under test (e.g. "
            "`WaveEngine`, `Cursor`, `segmentize`, `BpmTimeline`) from their source paths. "
            "Use `vi.useFakeTimers()` to control time deterministically. No DOM is available — test pure "
            "computed values / engine math, not UI. For complex T127-style specs, verify pure numeric consistency "
            "between WaveEngine (waveYAt/getPoints) and Cursor (update) across complex amplitudes (e.g. 0.7 / 1.3 / 2.7 / 3.4) "
            "and off-grid phases (e.g. 0.37 beat / 1.23 beat)."
        )
    else:
        runner_intro = (
            f"Write a thorough, interactive Playwright (TypeScript) automated browser test script for task {task.id} "
            f"({task.desc}), and save it DIRECTLY to `tests/{test_filename}` using your file-write tool.\n\n"
            "This runs headless Chromium against the Vite dev server. Use `page`, `expect` from '@playwright/test'. "
            "Navigate via HashRouter (`window.location.hash = '#/editor'`)."
        )

    prompt = fr"""{runner_intro}

Context (TEST-DRIVEN DEVELOPMENT):
This is a TDD task. The implementation code does NOT exist yet. Your job is to write a STRICT acceptance test that will initially FAIL (Red) and must later PASS (Green) once the Coder implements the feature. {"The recorded video is inspected by a Product Director (Gate C Reviewer) who requires per-requirement evidence." if test_runner == "playwright" else "The test results are inspected by a reviewer, so the assertions must be rigorous and unambiguous."}

Specification:
{spec}
{recent_rules}
{context_hints}
{task_type_guidance}

STRICT QA REQUIREMENTS (verify BEHAVIOR / INTERNAL STATE, never surface-only DOM presence):
1. MANDATORY 3-Step State-Transition Assertions (CRITICAL to prevent false-positives):
   - NEVER write surface-only existence checks (toBeVisible, toHaveCount, toBeDefined) alone.
   - For EACH feature requirement, write a 3-step dynamic test:
     [Step 1: Capture Initial State] -> read before state (e.g. initial segment count, play state, offset value).
     [Step 2: Perform User Interaction] -> click, type, or trigger action with realistic wait.
     [Step 3: Assert Resulting Transition] -> assert that state/computed value changed to the EXPECTED target outcome (e.g. segment beats quantized to exact multiples of snap resolution).
2. Dynamic Computed Values: Assert computed outputs (e.g. beats / snap is exact integer, playback position shifted by offset). Never accept un-implemented default values.
3. Simulate realistic, thorough interactions for ALL features. Use HashRouter (`window.location.hash = '#/editor'`).
4. Audio Loading & Decoding Wait (CRITICAL): `08.Reply.flac` is 68.8MB. Wait for decode/loading to complete (e.g. play button text leaves '読込中…' or buffer ready) before interacting. Use `page.waitForFunction` with max 30s timeout.
5. Number Input Assertion Rule (CRITICAL): `<input type="number">` normalizes `11.00` to `11`. Use `expect(Number(await input.inputValue())).toBeCloseTo(11)` or `toHaveValue(/^11(\.0+)?$/)` — never exact string equality.
6. Visual Capture Timing: `page.waitForTimeout(1000-2000)` between critical actions for transitions/animations.
7. Robust Locators & Stability: use text/roles/test IDs from actual implemented UI elements. Avoid guessing parent container IDs.
8. Console Error Monitoring: fail on any uncaught TypeError/ReferenceError.
9. Off-Grid (Fractional Timing) Principle: When testing quantization, snapping, or timing judgments, NEVER test only whole-beat/integer multiples (e.g. 1000ms / 2.0 beats). You MUST include fractional off-grid inputs (e.g. holding key for 1.2 beats or 1.3 beats when snap=0.5) to verify that the value accurately snaps to the nearest grid line and prevents overshoot.
 10. **Range-Overwrite / Recording Tasks: Do NOT hardcode expected end beats or preserved slice indices. After `exitRecordMode`, READ `actualEndBeat = await page.evaluate(() => (window as any).__lastFinishRecording?.endBeat)` and compute expected preserved segments DYNAMICALLY from `initialSegments` cumulative beats: `expectedIdx = findEndIdx(initialSegments, actualEndBeat)`. Use this dynamic `expectedPreserved` for assertions. Hardcoding `endBeat = 8` or `slice(2)` will FAIL on timing drift.**
 11. Single File Rule: write ONLY `tests/{test_filename}`. Do NOT modify other files. Do NOT run the test yourself.
 12. The test MUST be capable of FAILING now (Red) — never write assertions that trivially pass on an empty/initial state.

Output only: DONE when finished. Never paste full test code into chat.
"""
    QA_CONTINUE_RETRIES = 5
    continuation_prompt = (
        prompt
        + f"\n\n[CONTINUATION] 前回の実行では tests/{test_filename} を実際に書いていません"
        f"（書き込み完了前に終わりました）。今度は file-write ツールで tests/{test_filename} を"
        "「今すぐ直接」書いてください。説明だけでなく実際に書くこと。書き終わったら DONE のみ出力。"
    )

    cont_prompt = prompt
    for attempt in range(1, QA_CONTINUE_RETRIES + 1):
        mtime_before = test_file.stat().st_mtime if test_file.exists() else 0.0
        if attempt == 1:
            log.info("QA generating dynamic %s (test_runner=%s, TDD direct-write mode)...", test_filename, test_runner)
        else:
            log.info("QA did not write tests/%s (stopped partway). Continuing (attempt %d/%d)...", test_filename, attempt, QA_CONTINUE_RETRIES)
            cont_prompt = continuation_prompt
        _, out = run_opencode_with_retry(
            qa_model, cont_prompt, timeout=None, label="QA-Gen", variant="max",
            task_id=task.id, role="qa", state=state, fresh_sessions=fresh_sessions,
            title=qa_title,
        )

        wrote = test_file.exists() and test_file.stat().st_mtime > mtime_before
        if wrote:
            log.info("QA model wrote tests/%s directly.", test_filename)
            return True
    return False


def _vitest_is_broken(out: str) -> bool:
    """Detect a 'broken' vitest run: the test file failed to COMPILE/import, or produced no real
    test cases. These are false Reds (the test is just broken, not legitimately failing on
    assertions). A genuine Red must show real assertion failures on actual test cases."""
    low = out.lower()
    # No test files / no tests executed
    if re.search(r"no test files found|no tests found|tests?\s*0\s*(failed|passed)", low):
        return True
    # TypeScript / transform / import / resolution errors during collection
    if re.search(r"failed to load|failed to resolve|error while transforming|cannot find (module|name|type)|"
                 r"is not assignable|ts\d{4}|syntax ?error|transform error|failed to import|"
                 r"cannot find module|referenceerror: (module|require) is not defined", low):
        return True
    # A run that reports zero passed AND zero failed with an error banner is broken
    if re.search(r"error", low) and ("0 passed" in low or "no test" in low or "failed to" in low):
        return True
    return False


def run_dynamic_test_red(task: Task, test_runner: str = "vitest") -> tuple[bool, bool, str, bool]:
    """TDD Red phase: run the test ONCE. Returns (passed, broken, output, timed_out).

    - passed=True  : test PASSED on unimplemented code (false-positive / already implemented).
    - broken=True  : test is BROKEN (compile/import error, node collect failure, or zero real
                     tests) — a false Red. The QA test should be regenerated.
    - timed_out=True: the run hung and hit the timeout — the QA test should be regenerated.
    Genuine Red = not passed and not broken and not timed_out (assertions failed for the right reason).
    """
    test_file = _dynamic_test_file(test_runner)
    if not test_file.exists():
        return False, False, f"{test_file.name} does not exist", False
    if test_runner == "vitest":
        code, out, timed_out = run_cmd_pgid_stream(
            ["npx", "vitest", "run", f"tests/{test_file.name}"], timeout=PW_RED_TIMEOUT, prefix="red: "
        )
        passed = code == 0
        broken = (not passed) and (not timed_out) and _vitest_is_broken(out)
        return passed, broken, out, timed_out
    if not ensure_dev_server():
        return False, False, "Dev server failed to start", False
    code, out, timed_out = run_cmd_pgid_stream(
        ["npx", "playwright", "test", f"tests/{test_file.name}"], timeout=PW_RED_TIMEOUT, prefix="red: "
    )
    passed = code == 0
    # Playwright keeps existing behavior: only timed-out and passed are special-cased.
    return passed, False, out, timed_out


def run_gate_b_test(state: dict[str, Any] | None, task: Task, args: argparse.Namespace | None = None) -> GateResult:
    """Green phase: run the dynamic acceptance test with flaky-retry. Copies golden on success.

    For playwright: runs headless Chromium with video recording (reviewed by Gate C).
    For vitest: runs the node unit test directly; no video is produced, so Gate C uses
    check_gate_c_code_review (git diff based) instead.
    """
    if args and getattr(args, "code_review_only", False):
        return GateResult("Gate B (Dynamic Test)", True, "PASS (Skipped via --code-review-only mode)")

    if not task.test or not has_dev_script():
        return GateResult("Gate B (Dynamic Test)", True, f"Task {task.id} (test={task.test}) -> Skip dynamic test")

    tr = _test_runner(args)
    test_file = _dynamic_test_file(tr)
    if not test_file.exists():
        return GateResult("Gate B (Dynamic Test)", False, f"{test_file.name} not found (QA did not write it)")

    if tr == "vitest":
        log.info("Running Vitest execution (flaky-retry enabled, test_runner=vitest)...")
        passed_any = False
        test_out = ""
        pass_count = 0
        for v_attempt in range(1, 3):
            code, test_out, _ = run_cmd_pgid_stream(
                ["npx", "vitest", "run", f"tests/{test_file.name}"], timeout=PW_GREEN_TIMEOUT, prefix="vitest: "
            )
            if code == 0:
                passed_any = True
                m = re.search(r"Tests\s+(\d+)\s+passed", test_out)
                if m:
                    pass_count = int(m.group(1))
                break
            else:
                log.warning("Vitest run attempt %d failed. Retrying once...", v_attempt)
                time.sleep(2)
        if not passed_any:
            fatal_lines = [l for l in test_out.splitlines() if re.search(r"Error:|failed|AssertionError", l)]
            detail = "\n".join(fatal_lines) if fatal_lines else test_out[-1000:]
            return GateResult("Gate B (Dynamic Test)", False, detail)
        golden_file = ROOT / "tests" / f".gateb_{task.id}.test.ts"
        try:
            import shutil
            shutil.copy(test_file, golden_file)
            if state and task.id in state.get("tasks", {}):
                state["tasks"][task.id]["gate_b_golden"] = True
                save_state(state)
        except Exception:
            pass
        log.info("Vitest execution completed (%d test(s) passed).", pass_count)
        return GateResult("Gate B (Dynamic Test)", True, f"PASS ({pass_count} test(s) passed)")

    if not ensure_dev_server():
        return GateResult("Gate B (Dynamic Test)", False, "Dev server failed to start")

    log.info("Running Playwright execution with Video Recording (flaky-retry enabled)...")
    playwright_passed = False
    test_out = ""
    for pw_attempt in range(1, 3):
        code, test_out, _ = run_cmd_pgid_stream(
            ["npx", "playwright", "test", f"tests/{test_file.name}"], timeout=PW_GREEN_TIMEOUT, prefix="playwright: "
        )
        if code == 0:
            playwright_passed = True
            break
        else:
            log.warning("Playwright test attempt %d failed. Retrying once...", pw_attempt)
            time.sleep(2)

    if not playwright_passed:
        fatal_lines = [l for l in test_out.splitlines() if re.search(r"Error:|failed|Timed out", l)]
        detail = "\n".join(fatal_lines) if fatal_lines else test_out[-1000:]
        return GateResult("Gate B (Dynamic Test)", False, detail)

    golden_file = ROOT / "tests" / f".gateb_{task.id}.spec.ts"
    try:
        import shutil
        shutil.copy(test_file, golden_file)
        if state and task.id in state.get("tasks", {}):
            state["tasks"][task.id]["gate_b_golden"] = True
            save_state(state)
    except Exception:
        pass

    videos = sorted(list(VIDEO_DIR.glob("**/*.webm")), key=lambda p: p.stat().st_mtime)
    log.info("Playwright execution completed (%d video recording(s) captured).", len(videos))
    return GateResult("Gate B (Dynamic Test)", True, f"PASS ({len(videos)} video(s) recorded)")


def run_llm_cli_video_review(video_path: Path, prompt: str, timeout: int | None = None) -> tuple[int, str]:
    cmd = ["llm", "-m", "gemini-3.5-flash-lite", "-o", "thinking_level", "high", "-a", str(video_path), prompt]
    log.info("Dispatching Video Review via Simon Willison's llm CLI (model=gemini-3.5-flash-lite, video=%s)...", video_path.name)
    code = 1
    out = ""
    for attempt, delay in enumerate(BACKOFF_DELAYS, start=1):
        print(f"  {GRAY}┌─ Start: llm CLI Video Review (attempt {attempt}/{len(BACKOFF_DELAYS)}) ──────────────────────{RESET}", flush=True)
        code, out, timed_out = run_cmd_pgid_stream(cmd, timeout=timeout, prefix=f"{CYAN}::{RESET} ")
        print(f"  {GRAY}└─ End: llm CLI Video Review (exit={code}) ────────────────────────{RESET}", flush=True)
        if code == 0:
            return code, out
        if attempt < len(BACKOFF_DELAYS):
            log.warning("Video Review attempt %d failed (exit=%d). Backoff %ds...", attempt, code, delay)
            time.sleep(delay)
    return code, out


REVIEWER_QUORUM = 3  # Independent Gate C review sessions; UNANIMOUS PASS required.


def _build_reviewer_prompt(task: Task, spec: str, run_index: int, is_red_audit: bool = False, test_code: str = "") -> str:
    test_code_section = ""
    if test_code:
        test_code_section = f"""
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLAYWRIGHT TEST SOURCE CODE (`tests/dynamic.spec.ts`):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The video recording was generated by executing the following Playwright test script:
```typescript
{test_code[:3000]}
```

CROSS-VALIDATION INSTRUCTIONS:
- Review the automated test script above alongside the browser execution video.
- Note that headless Playwright dispatches keyboard interactions (e.g. `page.keyboard.press('Space')`) directly as browser DOM events; they do NOT render visual keystroke animations or on-screen fingers.
- Correlate the actions in the test code with the state changes and timeline visuals in the video (e.g. mode switches, ring counts, audio playback).
- If the test script genuinely exercises the requirements and the video confirms the expected UI transitions and resulting states, verify them as MET.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

    if is_red_audit:
        return f"""You are an Uncompromising Senior Product Director and Strict Quality Auditor performing a ZERO-CODER PRE-IMPLEMENTATION AUDIT on the browser execution video for task {task.id} ({task.desc}).

🚨 CRITICAL AUDIT CONTEXT (READ CAREFULLY):
This task was executed in TDD Pre-Implementation phase (Red Check), and ALL automated tests PASSED on the existing code WITHOUT ANY CODE CHANGES.

In many cases, this is a FALSE-POSITIVE caused by superficial, weak test assertions (e.g. asserting only that an element is visible or testing trivial baseline state without taking actions).
However, to avoid breaking already working code, if the test script genuinely tests the requirements with state transitions AND the browser video proves it works -> this feature was ALREADY IMPLEMENTED.

YOUR MISSION:
Scrutinize the test code and browser video with high standards:
1. Check the test code: Does it perform real state transitions (Capture State -> Perform Action -> Assert Result)?
2. Check the video: Does the UI transition and behave correctly without glitches or missing features?
- If the test is trivial/no-op, or the video shows broken behavior -> IMMEDIATELY REJECT with verdict "FAIL" (Score < 50) and label it a False-Positive.
- If the test script is rigorous and the video reflects full functionality and UI polish -> verdict "PASS" (Score >= 80).
{test_code_section}
Specification & Requirements to Audit:
{spec}

MANDATORY EVIDENCE PROTOCOL (Strict — no exceptions):
You MUST evaluate EVERY requirement listed above, one by one. For each requirement provide a CONCRETE, FALSIFIABLE piece of evidence observed in the video and test script (timestamp + action/assertion).
- If ANY requirement is status "UNMET" -> verdict MUST be "FAIL".

Output JSON only, with this exact schema:
{{"score": 90, "verdict": "PASS", "evidence": [{{"requirement": "<verbatim req>", "status": "MET", "proof": "00:03 clicked play, Space pressed in play mode did not add rings, 00:06 switched to record and Space added ring"}}], "comment": "Verified that this feature is genuinely ALREADY IMPLEMENTED."}}

If rejecting as false-positive:
{{"score": 30, "verdict": "FAIL", "evidence": [{{"requirement": "<req>", "status": "UNMET", "proof": "test assertions were static or video showed no relevant interaction"}}], "comment": "Rejected as False-Positive. Automated test passed without actually exercising the required feature."}}
"""

    return f"""You are an Uncompromising Product Director and Senior UX/UI Critic inspecting the browser execution video recording for task {task.id} ({task.desc}).

You are INDEPENDENT reviewer #{run_index + 1} of {REVIEWER_QUORUM}. Be especially skeptical — most submissions are superficial. Only PASS if you can cite concrete proof for EVERY requirement.
{test_code_section}
Specification & Intent (each bullet is a REQUIREMENT that must be evaluated individually):
{spec}

EVALUATION PHILOSOPHY & SCOPE:
- Do not merely check if technical bullet points or bare-minimum features exist. Evaluate whether the implementation achieves high-end product polish, delightful user experience (UX), and refined visual craftsmanship. If a feature technically works but feels crude, janky, unpolished, or visually unappealing, it fails.
- CRITICAL SCOPE CLARIFICATION: If the specification mentions "verify via automated tests", "make it verifiable by automated tests", or "自動テストで検証可能にする", Gate C evaluates the observable USER INTERFACE and BROWSER BEHAVIOR in the video. The automated test execution itself is strictly checked by Gate B (Playwright runner). Do NOT fail a submission merely because a terminal, console, or test runner is not shown in the video; instead, evaluate whether the underlying UI element, interaction, and resulting visual changes are working smoothly in the browser.

MANDATORY EXCELLENCE CRITERIA (All must be met for a PASS):
1. Fluidity & Responsiveness: Interactions and animations must be butter-smooth, responsive, and completely free of stutter, jank, or frozen states.
2. Visual Polish & Hierarchy: Clean typography, precise spacing, consistent styling, and professional aesthetic (no raw unstyled defaults or ugly overlapping).
3. Feedback & State Clarity: Clear, immediate visual feedback for user actions; accurate data presentation without flickering or visual artifacts.
4. Craft & Delight: The implementation should feel like a finished, polished product ready for users, demonstrating thoughtful care beyond mere functional compliance.

MANDATORY EVIDENCE PROTOCOL (Strict — no exceptions):
You MUST evaluate EVERY requirement listed in the Specification above, one by one. For each requirement provide a CONCRETE, FALSIFIABLE piece of evidence observed in the video (a timestamp + exactly what was seen/clicked). Abstract praise such as "works well", "properly implemented", or "looks good" WITHOUT a specific observable action is treated as UNMET.
- If ANY requirement is status "UNMET" or is absent from the evidence array -> verdict MUST be "FAIL".
- If any requirement's proof is vague / non-observable (fewer than ~8 meaningful characters) -> treat that requirement as UNMET.

Output JSON only, with this exact schema:
{{"score": 90, "verdict": "PASS", "evidence": [{{"requirement": "<verbatim requirement text or id from spec>", "status": "MET", "proof": "<specific observable evidence with timestamp, e.g. '00:12 clicked offset UI then audio sync shifted'>"}}], "comment": "detailed product/UX critique"}}

If something fails, output e.g.:
{{"score": 50, "verdict": "FAIL", "evidence": [{{"requirement": "<req text>", "status": "UNMET", "proof": "no observable evidence of the feature in the video"}}], "comment": "specific flaw observed"}}
"""


def _extract_json_object(out: str) -> dict | None:
    """Extract a top-level JSON object from model output with nested brace / markdown handling."""
    if not out:
        return None
    # 1. Look for markdown json code block (try from last to first)
    for pattern in [r'```(?:json)?\s*(\{.*?\})\s*```', r'```(?:json)?\s*(\[.*?\])\s*```']:
        matches = list(re.finditer(pattern, out, re.S))
        for m in reversed(matches):
            try:
                res = json.loads(m.group(1))
                if isinstance(res, dict): return res
                if isinstance(res, list) and res and isinstance(res[0], dict): return res[0]
            except Exception: pass

    # 2. Search backwards from the end of the text for any valid JSON object
    for i in range(len(out) - 1, -1, -1):
        if out[i] == '{':
            depth = 0
            in_string = False
            escape = False
            end_idx = -1
            for j in range(i, len(out)):
                char = out[j]
                if escape:
                    escape = False
                    continue
                if char == '\\':
                    escape = True
                    continue
                if char == '"':
                    in_string = not in_string
                    continue
                if not in_string:
                    if char == '{':
                        depth += 1
                    elif char == '}':
                        depth -= 1
                        if depth == 0:
                            end_idx = j
                            break
            if end_idx != -1:
                try:
                    candidate = out[i:end_idx + 1]
                    res = json.loads(candidate)
                    if isinstance(res, dict):
                        return res
                except Exception:
                    pass
    return None


def _extract_review_json(out: str) -> dict | None:
    """Extract the review-verdict JSON object, preferring a dict carrying BOTH 'score' and 'verdict' keys.

    The reviewer transcript (`opencode run` stdout) interleaves tool-call JSON fragments (e.g. `read`
    tool args like {"filePath": ...}) that lack review keys. The generic `_extract_json_object` picks the
    structurally-last valid object, which can be one of those foreign fragments, yielding a bogus
    `Score=0, Verdict=FAIL`. This helper scans ALL valid objects and prefers the one that actually
    holds a review verdict (last occurrence wins, i.e. the model's final answer).
    """
    verdict_candidates: list[dict] = []

    def is_verdict(d):
        return isinstance(d, dict) and ("score" in d) and ("verdict" in d)

    # 1. Markdown json code blocks (last to first preserves final-answer precedence)
    for pattern in [r'```(?:json)?\s*(\{.*?\})\s*```', r'```(?:json)?\s*(\[.*?\])\s*```']:
        for m in reversed(list(re.finditer(pattern, out, re.S))):
            try:
                res = json.loads(m.group(1))
                if isinstance(res, list) and res:
                    res = res[0]
                if is_verdict(res):
                    verdict_candidates.append(res)
            except Exception:
                pass

    # 2. Scan every brace-delimited JSON object, tracking candidates in byte order
    ordered: list[dict] = []
    n = len(out)
    i = 0
    while i < n:
        while i < n and out[i] != '{':
            i += 1
        if i >= n:
            break
        depth = 0
        in_string = False
        escape = False
        end_idx = -1
        j = i
        while j < n:
            char = out[j]
            if escape:
                escape = False
            elif char == '\\':
                escape = True
            elif char == '"':
                in_string = not in_string
            elif not in_string:
                if char == '{':
                    depth += 1
                elif char == '}':
                    depth -= 1
                    if depth == 0:
                        end_idx = j
                        break
            j += 1
        if end_idx != -1:
            try:
                res = json.loads(out[i:end_idx + 1])
                if isinstance(res, list) and res:
                    res = res[0]
                if is_verdict(res):
                    ordered.append(res)
            except Exception:
                pass
            i = end_idx + 1
        else:
            i += 1

    # Prefer markdown-block verdicts, then brace-scanned verdicts; last wins.
    candidates = verdict_candidates + ordered
    if candidates:
        return candidates[-1]

    # Fall back to generic extraction (unchanged behavior) if no verdict-shaped object is found.
    return _extract_json_object(out)


def _parse_review_verdict(out: str, task_id: str) -> tuple[bool, str]:
    res = _extract_review_json(out)
    if not res or not isinstance(res, dict):
        return False, f"Reviewer output did not contain valid evaluation JSON. Raw head: {out[:200]!r}"
    try:
        score = res.get("score", 0)
        verdict = res.get("verdict", "FAIL")
        comment = res.get("comment", "")
        evidence = res.get("evidence", [])
        ok = score >= 80 and str(verdict).upper() == "PASS"
        if ok:
            # Evidence protocol: every requirement must be MET with a concrete proof.
            if not isinstance(evidence, list) or len(evidence) == 0:
                ok = False
                comment = f"Reviewer provided no per-requirement evidence array. {comment}"
            else:
                for ev in evidence:
                    if not isinstance(ev, dict):
                        continue
                    status = str(ev.get("status", "")).upper()
                    proof = str(ev.get("proof", "")).strip()
                    if status != "MET" or len(proof) < 8:
                        ok = False
                        comment = f"Evidence gap for requirement '{ev.get('requirement', '?')}' (status={status}). {comment}"
                        break
        return ok, f"Score={score}, Verdict={verdict}: {comment}"
    except Exception as e:
        return False, f"Reviewer output evaluation error: {e}"


def check_gate_c(task: Task, reviewer_model: str, is_red_audit: bool = False) -> GateResult:
    gate_name = "Gate C (Already Implemented Audit)" if is_red_audit else "Gate C (Dynamic Review)"
    if not task.test or not has_dev_script():
        return GateResult(gate_name, True, f"Task {task.id} (test={task.test}) -> Skip dynamic review")

    videos = sorted(list(VIDEO_DIR.glob("**/*.webm")), key=lambda p: p.stat().st_mtime)
    if not videos:
        log.error("No gameplay video recording (.webm) found for Gate C.")
        return GateResult(gate_name, False, "No gameplay video recorded")

    latest_video = videos[-1]
    spec = extract_compact_spec(task.id)

    test_code = ""
    if DYNAMIC_SPEC_FILE.exists():
        try:
            test_code = DYNAMIC_SPEC_FILE.read_text(encoding="utf-8")
        except Exception:
            pass

    results: list[tuple[bool, str]] = []
    for i in range(REVIEWER_QUORUM):
        prompt = _build_reviewer_prompt(task, spec, i, is_red_audit=is_red_audit, test_code=test_code)
        log.info("Reviewer session %d/%d (%s) analyzing video: %s...", i + 1, REVIEWER_QUORUM, "audit" if is_red_audit else "independent", latest_video.name)
        code, out = run_llm_cli_video_review(latest_video, prompt, timeout=None)
        if code != 0:
            results.append((False, f"session {i+1}: model execution failed (exit={code})"))
            continue
        ok, reason = _parse_review_verdict(out, task.id)
        score_color = GREEN if ok else RED
        log.info("Review %d/%d Verdict: %s%s%s | Reason: %s", i + 1, REVIEWER_QUORUM, score_color, "PASS" if ok else "FAIL", RESET, reason)
        results.append((ok, f"session {i+1}: {reason}"))

    passed = sum(1 for ok, _ in results if ok)
    if passed == REVIEWER_QUORUM:
        return GateResult(gate_name, True, f"Unanimous PASS ({passed}/{REVIEWER_QUORUM} independent reviews)")

    fails = [reason for ok, reason in results if not ok]
    detail = "; ".join(fails)
    log.error("[%s] %s quorum FAILED: %d/%d independent reviews passed.", task.id, gate_name, passed, REVIEWER_QUORUM)
    return GateResult(gate_name, False, f"Quorum FAIL ({passed}/{REVIEWER_QUORUM} passed): {detail}")


def check_gate_c_code_review(
    task: Task,
    reviewer_model: str,
    head_hash: str,
    state: dict[str, Any] | None = None,
    fresh_sessions: bool = False,
) -> GateResult:
    gate_name = "Gate C (Code Review)"
    # 変更されたファイルリストを取得
    _, changed_files_out, _ = run_cmd_pgid_stream(["git", "diff", "--name-only", f"{head_hash}..HEAD"])
    changed_files = [f for f in changed_files_out.splitlines() if f.strip().startswith("src/")]

    if not changed_files:
        return GateResult(gate_name, False, "No src code changes found")

    spec = extract_compact_spec(task.id)
    prompt = f"""You are an Uncompromising Senior Code Auditor and Lead Architect reviewing the implementation for task {task.id} ({task.desc}).

Specification & Requirements (each requirement bullet must be verified in the code):
{spec}

FILES TO INSPECT:
{", ".join(changed_files)}

EVALUATION INSTRUCTIONS:
1. USE THE `read` TOOL to examine the source files listed above in detail.
2. Verify that all requirements in the Specification have been fully implemented in the source code.
3. Check for completeness, correctness, type safety, and project convention adherence.

MANDATORY EVIDENCE PROTOCOL:
For EVERY requirement in the Specification above, cite the specific file path, function, or code line in the source code that implements it.

Output JSON only with this schema:
{{
  "score": 90,
  "verdict": "PASS",
  "evidence": [
    {{"requirement": "<verbatim requirement>", "status": "MET", "proof": "src/chart/loader.ts: added audio_offset parsing logic"}}
  ],
  "comment": "all requirements verified by reading source code"
}}

If ANY requirement is missing or incomplete:
{{
  "score": 40,
  "verdict": "FAIL",
  "evidence": [
    {{"requirement": "<missing requirement>", "status": "UNMET", "proof": "not found in source code"}}
  ],
  "comment": "missing implementation for requirement X"
}}
"""

    log.info("[%s] Dispatching Gate C Code Reviewer (model=%s, files=%d)...", task.id, reviewer_model, len(changed_files))
    rev_title = f"[{task.id}] CodeReview {uuid.uuid4().hex[:8]}"
    code, out = run_opencode_with_retry(
        reviewer_model, prompt, timeout=None, label=f"CodeReviewer({task.id})", variant="max",
        task_id=task.id, role="reviewer", state=state, fresh_sessions=fresh_sessions,
        title=rev_title,
    )

    if code != 0:
        return GateResult(gate_name, False, f"Code Reviewer model failed to execute (exit={code})")

    ok, reason = _parse_review_verdict(out, task.id)
    score_color = GREEN if ok else RED
    log.info("Code Review Verdict: %s%s%s | Reason: %s", score_color, "PASS" if ok else "FAIL", RESET, reason)

    if ok:
        return GateResult(gate_name, True, f"PASS ({reason})")
    return GateResult(gate_name, False, reason)


def decode_retry_from(pm: Any, coder_commit: str | None) -> str:
    if isinstance(pm, dict):
        retry = pm.get("retry_from")
        if retry == "qa" and coder_commit:
            return "qa"
        if retry == "reviewer":
            return "reviewer"
    return "coder"


def _extract_postmortem_json(out: str) -> dict | None:
    return _extract_json_object(out)


def generate_postmortem(task: Task, error_detail: str, postmortem_model: str, state: dict[str, Any] | None = None, fresh_sessions: bool = False) -> dict:
    POSTMORTEM_DIR.mkdir(exist_ok=True)
    if state and task.id in state.get("tasks", {}):
        state["tasks"][task.id].setdefault("sessions", {})["postmortem"] = None
    prompt = f"""Analyze the failure for task {task.id}. Determine root cause, generate a prohibited rule, and provide an ACTIONABLE prescription (fix_hint) for the next attempt.

Failure Log:
{error_detail[:1200]}

Decide where the next retry should restart from:
- "coder": the failure is due to the implementation code (Coder output) and it must be regenerated.
- "qa": the implementation code is acceptable but the dynamic test / verification approach (QA-Gen test script or how it was exercised) was flawed; reuse the Coder output and regenerate only the test.
- "reviewer": the failure is purely due to the Code Reviewer's output formatting/JSON parsing error rather than any code or test flaw; reuse both Coder and QA outputs and re-run only the Gate C Code Reviewer.

Output JSON only:
{{
  "approach": "approach taken",
  "root_cause": "concise root cause description",
  "prohibited_rule": "prohibited rule for next run (what NOT to do)",
  "fix_hint": "clear, actionable prescription for Coder/QA (e.g. which exact selectors to use, what DOM/state logic to fix, how to calculate values)",
  "retry_from": "coder" or "qa" or "reviewer"
}}
"""
    log.info("Postmortem analyzing failure and formulating actionable prescriptions...")
    pm_title = f"[{task.id}] Postmortem {uuid.uuid4().hex[:8]}"
    _, out = run_opencode_with_retry(
        postmortem_model, prompt, timeout=None, label="Postmortem", variant="max",
        task_id=task.id, role="postmortem", state=state, fresh_sessions=fresh_sessions,
        title=pm_title,
    )

    entry = f"\n### [{time.strftime('%Y-%m-%d %H:%M:%S')}] Task {task.id} Failure\n```\n{out}\n```\n"
    with open(POSTMORTEM_FILE, "a", encoding="utf-8") as f:
        f.write(entry)
    log.info("Updated POSTMORTEM.md.")

    data = _extract_postmortem_json(out)
    if not data:
        log.warning("Postmortem JSON parse failed; defaulting retry_from=coder. Raw head: %s", out[:400])
        data = {"approach": "", "root_cause": "", "prohibited_rule": "", "fix_hint": "", "retry_from": "coder"}

    # Update shared task context
    ctx = load_task_context(task.id)
    ctx["last_failure"] = {
        "error_summary": error_detail[:600],
        "root_cause": data.get("root_cause", ""),
    }
    if data.get("prohibited_rule"):
        ctx.setdefault("prohibited_rules", []).append(data["prohibited_rule"])
    if data.get("fix_hint"):
        ctx.setdefault("fix_hints", []).append(data["fix_hint"])
    ctx["last_retry_from"] = data.get("retry_from", "coder")
    save_task_context(task.id, ctx)
    # Persist for --resume across restarts
    if state is not None and task.id in state.get("tasks", {}):
        state["tasks"][task.id]["last_retry_from"] = data.get("retry_from", "coder")
        state["tasks"][task.id]["last_postmortem_at"] = time.time()
        save_state(state)

    return {
        "approach": data.get("approach", ""),
        "root_cause": data.get("root_cause", ""),
        "rule": data.get("prohibited_rule", ""),
        "fix_hint": data.get("fix_hint", ""),
        "retry_from": data.get("retry_from", "coder"),
    }


def git_checkpoint(message: str) -> None:
    run_cmd_pgid_stream(["git", "add", "-A"])
    run_cmd_pgid_stream(["git", "commit", "-m", message, "--allow-empty"])


def deploy_to_github_pages(task_id: str) -> None:
    """Build production dist and push to origin main for live GitHub Pages preview."""
    log.info("[%s] Building docs/ dist for GitHub Pages...", task_id)
    code, _, _ = run_cmd_pgid_stream(["npm", "run", "build"], timeout=60)
    if code == 0:
        run_cmd_pgid_stream(["git", "add", "docs"])
        run_cmd_pgid_stream(["git", "commit", "-m", f"build(docs): update GitHub Pages for {task_id}", "--allow-empty"])
        log.info("[%s] Pushing latest build to GitHub...", task_id)
        p_code, _, _ = run_cmd_pgid_stream(["git", "push", "origin", "main"], timeout=30)
        if p_code == 0:
            log.info("[%s] %sSuccessfully deployed to GitHub Pages!%s", task_id, GREEN, RESET)
        else:
            log.warning("[%s] git push to origin main skipped or failed (check network/credentials).", task_id)
    else:
        log.warning("[%s] npm run build failed during GitHub Pages deploy.", task_id)


def git_rollback(commit_hash: str) -> None:
    log.warning("Task failed. Rolling back to commit %s", commit_hash)
    run_cmd_pgid_stream(["git", "reset", "--hard", commit_hash])
    run_cmd_pgid_stream(["git", "clean", "-fd"])


def exec_task(task: Task, state: dict[str, Any], models: FlowModels, args: argparse.Namespace, fresh_sessions: bool = False) -> str:
    st = state["tasks"].setdefault(task.id, {"attempts": 0, "status": "pending"})
    if fresh_sessions:
        st["sessions"] = {}
    
    if args.only:
        log.info("[%s] --only mode: skipping dependency checks.", task.id)
    else:
        for dep in task.depends_on:
            dep_st = state["tasks"].get(dep, {}).get("status")
            if dep_st != "passed":
                log.warning("[%s] Blocked by incomplete dependency: %s (%s)", task.id, dep, dep_st)
                st["status"] = "blocked"
                save_state(state)
                return "blocked"

    print("\n" + f"{INDIGO}═══ [{task.id}] {task.desc} ══════════════════════════════════════{RESET}")
    st["status"] = "running"
    st["started"] = time.time()
    save_state(state)

    # タスク開始時に必ずコミットし、ロールバック先（開始時点の完全な状態）を保証する
    git_checkpoint(f"wip({task.id}): start")
    _, head_hash, _ = run_cmd_pgid_stream(["git", "rev-parse", "HEAD"])
    head_hash = head_hash.strip()

    MAX_CYCLES = 10
    NO_PROGRESS_LIMIT = 3
    cycles = 0
    no_progress_streak = 0
    best_stage = 0  # 0:未達 / 1:Gate A通過 / 2:Gate B通過 / 3:全ゲート通過
    is_code_review_only = getattr(args, "code_review_only", False)
    tr = _test_runner(args)
    test_file = _dynamic_test_file(tr)
    test_filename = _qa_test_filename(tr)
    need_coder = True if is_code_review_only else False  # TDD: Coder runs AFTER QA-Gen writes the test
    need_test = bool(task.test) and not is_code_review_only  # TDD: (re)generate acceptance test first; skip for non-test tasks
    if is_code_review_only:
        log.info("[%s] Code Review Only mode active: skipping QA-Gen & Playwright video tests, using git diff AI code review.", task.id)
    coder_commit = None

    # Task-start cleanup (prevents cross-task test leakage): the dynamic test file is SHARED across
    # tasks (tests/dynamic.test.ts), so a leftover from a previous task (e.g. T127's test lingering
    # into T128) would otherwise be silently reused. For UI tasks, clear the shared test at start so
    # QA-Gen writes a fresh task-specific acceptance test. --force-qa-gen keeps this behavior by
    # forcing regeneration regardless. A manually written test can still be preserved per-task via the
    # golden restore path if it is missing here.
    # --resume: keep existing dynamic test and skip cleanup to resume from last role.
    if getattr(args, "resume", False):
        if test_file.exists():
            log.info("[%s] --resume: Keeping existing tests/%s (skip clean) to resume from last role.", task.id, test_filename)
        # do not unlink; fall through to fast-path handling
    elif need_test and not getattr(args, "force_qa_gen", False):
        if test_file.exists():
            try:
                test_file.unlink()
                log.info("[%s] Removed shared tests/%s at task start so a task-specific test is regenerated.", task.id, test_filename)
            except Exception:
                pass

    # Fast-path: if the dynamic test already exists (e.g. written manually or from previous run),
    # skip QA-Gen and go straight to Red check / Gate B — unless --force-qa-gen regenerates it.
    # Note: the dynamic test file is SHARED across tasks (tests/dynamic.test.ts), so a leftover
    # from a previous task (e.g. T127's test) must NOT be silently reused as this task's acceptance
    # test. --force-qa-gen always regenerates. Otherwise an existing file is validated via Red check
    # in the main TDD loop rather than trusted blindly.
    if need_test and test_file.exists() and not getattr(args, "force_qa_gen", False):
        log.info("[%s] tests/%s already exists → skipping QA-Gen (use --force-qa-gen to regenerate); will validate via Red check.", task.id, test_filename)
        need_test = False
        need_coder = False  # will be set True inside the loop if the existing test genuinely fails on unimplemented code

    # --resume strict resumption: if Postmortem JSON exists, honor its retry_from to decide next role
    if getattr(args, "resume", False):
        try:
            ctx_r = load_task_context(task.id)
            last_retry = state.get("tasks", {}).get(task.id, {}).get("last_retry_from") or ctx_r.get("last_retry_from")
            if last_retry:
                log.info("[%s] --resume: last Postmortem retry_from=%s → strict resume (json-driven)", task.id, last_retry)
                if last_retry == "qa":
                    need_test = True and not is_code_review_only
                    need_coder = False
                    log.info("[%s] --resume: next role = QA-Gen (regenerate test, keep Coder output if any)", task.id)
                elif last_retry == "reviewer":
                    need_test = False
                    need_coder = False
                    log.info("[%s] --resume: next role = Gate C Reviewer only (skip QA/Coder, re-run review)", task.id)
                    # Gate C reviewer-only will be driven by need_test=False/need_coder=False → Gate A/B/C path
                else:  # coder
                    need_test = False
                    need_coder = True
                    log.info("[%s] --resume: next role = Coder (regenerate implementation)", task.id)
                # keep existing dynamic test when retry_from is not qa (Coder/Reviewer reuse it)
                if last_retry in ("coder", "reviewer") and test_file.exists():
                    need_test = False
            else:
                log.info("[%s] --resume: no last_retry_from found (first run or Postmortem JSON parse failed) → keeping test file, resuming from current stage (need_test=%s need_coder=%s)", task.id, need_test, need_coder)
                # keep file already handled above; do not force QA regen
                if test_file.exists():
                    need_test = False
        except Exception as exc:
            log.warning("[%s] --resume: failed to read last_retry_from (%s), falling back to file-keep resume", task.id, exc)

    def mark_stage(stage: int) -> None:
        nonlocal best_stage, no_progress_streak
        if stage > best_stage:
            log.info("[%s] Progress: stage %d -> %d", task.id, best_stage, stage)
            best_stage = stage
            no_progress_streak = 0
        else:
            no_progress_streak += 1
            log.warning("[%s] No progress at stage %d (best=%d, streak %d/%d)", task.id, stage, best_stage, no_progress_streak, NO_PROGRESS_LIMIT)

    def maybe_reset_cycle() -> None:
        nonlocal cycles, no_progress_streak, need_coder, need_test
        if no_progress_streak >= NO_PROGRESS_LIMIT:
            cycles += 1
            no_progress_streak = 0
            need_coder = True
            need_test = bool(task.test) and not is_code_review_only
            log.warning("[%s] %d consecutive attempts without progress. Rolling back to task-start commit and restarting cycle (%d/%d).", task.id, NO_PROGRESS_LIMIT, cycles, MAX_CYCLES)
            git_rollback(head_hash)

    while cycles < MAX_CYCLES:
        st["attempts"] = st.get("attempts", 0) + 1
        st["cycles"] = cycles + 1
        save_state(state)
        log.info("Starting implementation [%s] (attempt %d, cycle %d/%d)", task.id, st["attempts"], cycles + 1, MAX_CYCLES)

        # --- TDD Phase 1: obtain the acceptance test (Red stage) ---
        if need_test:
            if test_file.exists():
                try:
                    test_file.unlink()
                except Exception:
                    pass
            wrote = generate_qa_test(task, models.qa, state=state, fresh_sessions=fresh_sessions, test_runner=tr)
            if not wrote:
                log.error("[%s] QA-Gen failed to write tests/%s.", task.id, test_filename)
                generate_postmortem(task, f"QA-Gen did not write tests/{test_filename}.", models.postmortem, state=state, fresh_sessions=fresh_sessions)
                need_test = True
                need_coder = False
                mark_stage(0)
                maybe_reset_cycle()
                continue
        else:
            # Reusing an existing test (leftover from a previous task, manually written, or a
            # golden restored after rollback): ensure the test file exists, then validate it via
            # the Red check below just like a freshly generated test — NEVER trust it blindly, since
            # the shared tests/dynamic.test.ts may be a leftover from a DIFFERENT task (e.g. T127's
            # test leaking into T128). A genuine Red sets need_coder; a false-positive (pass on
            # unimplemented code) regenerates the test.
            if not test_file.exists():
                golden_file = ROOT / "tests" / (f".gateb_{task.id}.test.ts" if tr == "vitest" else f".gateb_{task.id}.spec.ts")
                if golden_file.exists():
                    import shutil
                    shutil.copy(golden_file, test_file)
                else:
                    log.error("[%s] No test file (%s) and no golden available. Must regenerate from QA.", task.id, test_filename)
                    generate_postmortem(task, f"No test file ({test_filename}) and no golden. QA-Gen did not write a test.", models.postmortem, state=state, fresh_sessions=fresh_sessions)
                    need_test = True
                    need_coder = False
                    mark_stage(0)
                    maybe_reset_cycle()
                    continue

        # Red verification: the test MUST FAIL before implementation exists (catch false-positives).
        # Runs on BOTH freshly-QA-generated and reused/restored tests so need_coder is decided from
        # actual evidence, not from whether a stale file happened to exist.
        # --skip-red-check: bypass entire Red verification and go straight to Coder (emergency escape for false-positive loops)
        if args and getattr(args, "skip_red_check", False):
            log.warning("[%s] --skip-red-check: Skipping Red verification, proceeding directly to Coder (Green).", task.id)
            need_coder = True
        else:
            if not test_file.exists():
                log.error("[%s] No test file found for Red check.", task.id)
                generate_postmortem(task, f"No test file ({test_filename}) for Red check.", models.postmortem, state=state, fresh_sessions=fresh_sessions)
                need_test = True
                need_coder = False
                mark_stage(0)
                maybe_reset_cycle()
                continue
            red_passed, red_broken, red_out, red_timed_out = run_dynamic_test_red(task, tr)
            if red_timed_out:
                log.error("[%s] Gate B Red check HUNG (timed out). QA test is bogus/unrunnable. Regenerating test from QA...", task.id)
                generate_postmortem(
                    task,
                    f"QA test HUNG/timed out during Red check (test_runner={tr}). "
                    "The test did not exit within the timeout — likely bad/browser-side vitest usage, infinite loop, "
                    "or waiting on DOM that never resolves. Rewrite as a pure node unit test (vi.useFakeTimers()) that "
                    "exits promptly even when the feature is unimplemented.",
                    models.postmortem, state=state, fresh_sessions=fresh_sessions,
                )
                need_test = True
                need_coder = False
                mark_stage(0)
                maybe_reset_cycle()
                continue
            if red_broken:
                log.error("[%s] Gate B Red check: test file is BROKEN (compile/import error or no real tests). This is a FALSE Red. Regenerating test from QA...", task.id)
                broken_lines = [l.strip() for l in red_out.splitlines() if re.search(r"Error|failed to|Cannot find|not assignable|transform|no test|Cannot find module", l)]
                sample = "\n".join(broken_lines[:6]) if broken_lines else red_out[-400:]
                generate_postmortem(
                    task,
                    f"QA test is BROKEN during Red check (test_runner={tr}) — the test file failed to compile/import "
                    "or produced zero real test cases:\n"
                    f"{sample}\n"
                    "A genuine Red must show actual assertion FAILURES on real tests. Rewrite so the module(s) import "
                    "cleanly, the tests collect, and they assert expected behavior on the (currently unimplemented) code "
                    "such that at least one test genuinely fails.",
                    models.postmortem, state=state, fresh_sessions=fresh_sessions,
                )
                need_test = True
                need_coder = False
                mark_stage(0)
                maybe_reset_cycle()
                continue
            if red_passed:
                log.warning("[%s] Gate B Red check: all tests passed on existing code. Auditing if ALREADY IMPLEMENTED via Gate C...", task.id)
                # Check if existing code builds cleanly (Gate A)
                ga_result = check_gate_a()
                if ga_result.ok:
                    # Run strict Zero-Coder Gate C review (video for playwright, git diff code review for vitest)
                    if tr == "vitest":
                        gc_audit = check_gate_c_code_review(task, models.reviewer, head_hash, state=state, fresh_sessions=fresh_sessions)
                    else:
                        gc_audit = check_gate_c(task, models.reviewer, is_red_audit=True)
                    if gc_audit.ok:
                        log.info("[%s] ★★★ Task is ALREADY IMPLEMENTED and verified by Gate C! (Skipping Coder to prevent code degradation)", task.id)
                        golden_file = ROOT / "tests" / (f".gateb_{task.id}.test.ts" if tr == "vitest" else f".gateb_{task.id}.spec.ts")
                        try:
                            import shutil
                            shutil.copy(test_file, golden_file)
                            if state and task.id in state.get("tasks", {}):
                                state["tasks"][task.id]["gate_b_golden"] = True
                        except Exception:
                            pass
                        git_checkpoint(f"feat({task.id}): complete (already implemented)")
                        deploy_to_github_pages(task.id)
                        st["status"] = "passed"
                        st["finished"] = time.time()
                        state["consecutive_no_action"] = 0
                        save_state(state)
                        ctx = load_task_context(task.id)
                        ctx["status"] = "passed"
                        save_task_context(task.id, ctx)
                        print(f"{GREEN}{BOLD}>>> [{task.id}] ALL GATES PASSED (Already Implemented, duration: {st['finished'] - st['started']:.1f}s){RESET}\n")
                        return "passed"
                    else:
                        log.error("[%s] Gate C Audit rejected Zero-Coder pass (confirmed FALSE-POSITIVE): %s", task.id, gc_audit.detail)
                else:
                    log.error("[%s] Existing code fails Gate A (tsc). Cannot be Already Implemented.", task.id)

                log.error("[%s] Gate B Red check FAILED: test passed WITHOUT any implementation (false-positive). Rejecting QA test.", task.id)
                passed_lines = [l.strip() for l in red_out.splitlines() if "passed" in l or "✓" in l or "›" in l]
                sample_passed = "\n".join(passed_lines[:6]) if passed_lines else red_out[-400:]
                pm_detail = (
                    f"QA test is a FALSE-POSITIVE (all tests passed on UNIMPLEMENTED code):\n{sample_passed}\n"
                    "The assertions were too weak (e.g. only verified initial DOM/state or default values), "
                    "OR the test file is a leftover from a different task and does not actually test THIS task. "
                    "Rewrite strict 3-step state-transition assertions ([Capture Before] -> [Perform Action] -> [Assert Changed Outcome]) "
                    "that GUARANTEE failure on unimplemented features."
                )
                generate_postmortem(task, pm_detail, models.postmortem, state=state, fresh_sessions=fresh_sessions)
                need_test = True
                need_coder = False
                mark_stage(0)
                maybe_reset_cycle()
                continue
            log.info("[%s] Gate B Red check OK: test fails as expected (pre-implementation).", task.id)
            # Red → Green handoff: Genuine Red confirmed (test FAILS for the right reason).
            # Now the Coder must run to implement the feature BEFORE Gate B (Green) executes —
            # otherwise Gate B runs against unimplemented code, fails spuriously, and wastes a
            # full cycle + postmortem. (Fixes skipped-Coder bug.)
            need_coder = True

        # --- TDD Phase 2: Coder implements to make the test Green (+ Gate A) ---
        if need_coder:
            if state and task.id in state.get("tasks", {}):
                state["tasks"][task.id]["gate_b_golden"] = False
                state["tasks"][task.id].setdefault("sessions", {})["coder"] = None
            coder_title = f"[{task.id}] Coder {uuid.uuid4().hex[:8]}"
            prompt = build_compact_coder_prompt(task, debug_mode=args.debug_mode)
            code, out = run_opencode_with_retry(
                models.coder, prompt, timeout=None, label=f"Coder({task.id})", variant="medium",
                task_id=task.id, role="coder", state=state, fresh_sessions=fresh_sessions,
                title=coder_title,
            )
            (LOG_DIR / f"{task.id}_agent.log").write_text(out, encoding="utf-8")

            if out.strip() == "":
                log.error("[%s] Coder returned empty output (did nothing).", task.id)
                state["consecutive_no_action"] = state.get("consecutive_no_action", 0) + 1
                save_state(state)
                if state["consecutive_no_action"] >= 3:
                    log.critical("Killswitch triggered due to 3 consecutive no-action (empty output) detections.")
                    st["status"] = "failed"
                    st["finished"] = time.time()
                    save_state(state)
                    return "failed"
                need_coder = True
                mark_stage(0)
                maybe_reset_cycle()
                continue

            # Check Coder exit code - fail fast on rate limit or other errors before Gate A
            if code != 0:
                if "Rate limit exceeded" in out or "429" in out or "Too Many Requests" in out:
                    log.warning("[%s] Coder hit rate limit (exit=%d). Retrying...", task.id, code)
                    # Don't mark_stage(0) for rate limit - let outer loop retry without incrementing streak
                    continue
                else:
                    log.error("[%s] Coder failed with exit code %d: %s", task.id, code, out[:200])
                    generate_postmortem(task, f"Coder failed:\n{out}", models.postmortem, state=state, fresh_sessions=fresh_sessions)
                    need_coder = True
                    mark_stage(0)
                    maybe_reset_cycle()
                    continue

            if state.get("consecutive_no_action", 0) != 0:
                state["consecutive_no_action"] = 0
                save_state(state)

            ga = check_gate_a()
            if not ga.ok:
                log.error("[%s] Gate A failed: %s", task.id, ga.detail)
                generate_postmortem(task, f"Gate A (tsc) failed:\n{ga.detail}", models.postmortem, state=state, fresh_sessions=fresh_sessions)
                need_coder = True
                mark_stage(0)
                maybe_reset_cycle()
                continue
            log.info("[%s] %sGate A (tsc) PASS%s", task.id, GREEN, RESET)
            git_checkpoint(f"checkpoint({task.id}, gate-a)")
            _, coder_commit, _ = run_cmd_pgid_stream(["git", "rev-parse", "HEAD"])
            coder_commit = coder_commit.strip()

            # Record implemented UI elements and modified files into shared task context
            ctx = load_task_context(task.id)
            ctx["implemented_ui"] = extract_implemented_ui(task.id)
            save_task_context(task.id, ctx)
            log.info("[%s] Updated shared task context with %d ID(s) and %d data-testid(s).",
                     task.id, len(ctx["implemented_ui"]["ids"]), len(ctx["implemented_ui"]["test_ids"]))

        # --- TDD Phase 3: Gate B (Green) run the acceptance test ---
        gb = run_gate_b_test(state, task, args)
        if not gb.ok:
            if gb.fatal:
                log.error("[%s] Gate B failed (fatal): %s", task.id, gb.detail)
                st["status"] = "failed"
                st["finished"] = time.time()
                save_state(state)
                return "failed"
            log.error("[%s] Gate B failed: %s", task.id, gb.detail)
            pm = generate_postmortem(task, f"Gate B (Dynamic Test) failed:\n{gb.detail}", models.postmortem, state=state, fresh_sessions=fresh_sessions)
            if decode_retry_from(pm, coder_commit) == "qa":
                log.info("[%s] Postmortem: retry from QA-Gen (regenerate test).", task.id)
                need_test = True and not is_code_review_only
                need_coder = False
            else:
                need_coder = True
                need_test = False
            mark_stage(1)
            maybe_reset_cycle()
            continue
        log.info("[%s] %sGate B (Dynamic Test) PASS%s", task.id, GREEN, RESET)
        git_checkpoint(f"checkpoint({task.id}, gate-b)")

        # 4. Gate C (Reviewer)
        if is_code_review_only or _test_runner(args) == "vitest":
            gc = check_gate_c_code_review(task, models.reviewer, head_hash, state=state, fresh_sessions=fresh_sessions)
        else:
            gc = check_gate_c(task, models.reviewer)
        if not gc.ok:
            log.error("[%s] Gate C failed: %s", task.id, gc.detail)
            pm = generate_postmortem(task, f"Gate C (Dynamic Review) failed:\n{gc.detail}", models.postmortem, state=state, fresh_sessions=fresh_sessions)
            retry_from = decode_retry_from(pm, coder_commit)
            if retry_from == "qa":
                log.info("[%s] Postmortem: retry from QA-Gen (reuse Coder output).", task.id)
                need_coder = False
                need_test = True
            elif retry_from == "reviewer":
                log.info("[%s] Postmortem: retry from Gate C Reviewer only.", task.id)
                need_coder = False
                need_test = False
            else:
                need_coder = True
                need_test = False
            mark_stage(2)
            maybe_reset_cycle()
            continue
        log.info("[%s] %sGate C (Dynamic Review) PASS%s", task.id, GREEN, RESET)

        # Complete
        git_checkpoint(f"feat({task.id}): complete")
        deploy_to_github_pages(task.id)
        st["status"] = "passed"
        st["finished"] = time.time()
        state["consecutive_no_action"] = 0
        save_state(state)

        ctx = load_task_context(task.id)
        ctx["status"] = "passed"
        save_task_context(task.id, ctx)

        print(f"{GREEN}{BOLD}>>> [{task.id}] ALL GATES PASSED (duration: {st['finished'] - st['started']:.1f}s){RESET}\n")

        if args.step:
            input(f"{CYAN}Task [{task.id}] passed. Press Enter to proceed to next task...{RESET}")

        return "passed"

    st["status"] = "failed"
    st["finished"] = time.time()
    save_state(state)
    print(f"{RED}{BOLD}>>> [{task.id}] FAILED after {MAX_CYCLES} rollback cycles{RESET}\n")
    return "failed"


def detect_concurrent_orchestrators() -> list[int]:
    """Return PIDs of other live orchestrator.py processes (excluding self).

    Scans /proc to avoid matching our own process or the transient pgrep
    command. Used to warn the user before launching a second concurrent run,
    which would otherwise fight over port 5173.
    """
    me = os.getpid()
    ppid = os.getppid()
    others: list[int] = []
    proc_root = Path("/proc")
    if not proc_root.exists():
        return others
    for entry in proc_root.iterdir():
        name = entry.name
        if not name.isdigit():
            continue
        pid = int(name)
        if pid == me or pid == ppid:
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes()
        except (OSError, PermissionError):
            continue
        if not cmdline:
            continue
        parts = [p.decode("utf-8", errors="ignore") for p in cmdline.split(b"\x00") if p]
        if any("orchestrator.py" in part for part in parts) and any("python" in part for part in parts):
            others.append(pid)
    return others


def main() -> None:
    parser = argparse.ArgumentParser(description="Trace Wave Autonomous Orchestrator (Modern CLI)")
    parser.add_argument("--dry-run", action="store_true", help="Display execution plan only")
    parser.add_argument("--only", metavar="TID", help="Execute specific task ID")
    parser.add_argument("--range", nargs=2, metavar=("FROM", "TO"), help="Execute tasks from FROM to TO inclusive (by DAG order), e.g. --range T99 T105")
    parser.add_argument("--force", action="store_true", help="Force re-execution of passed tasks")
    parser.add_argument("--step", action="store_true", help="1タスク完了ごとにEnterキー確認を挟む（ステップ実行モード）")
    parser.add_argument("--reset-state", action="store_true", help="Reset state file")
    parser.add_argument("--reset-task", metavar="TID", help="Reset a specific task (e.g. T127) to its start checkpoint: reset its status to pending, remove its test/golden files, and roll back ONLY the task's own source changes (orchestrator.py / config / state are preserved so the tooling itself is never reset)")
    parser.add_argument("--budget-min", type=int, default=DEFAULT_BUDGET_MIN, help="Total budget in minutes")
    parser.add_argument("--non-interactive", action="store_true", help="Skip interactive model selector")
    parser.add_argument("--fresh-sessions", action="store_true", help="Always create fresh OpenCode sessions for tasks (ignoring past sessions)")
    parser.add_argument("--coder", help="Override Coder model ID or short key (e.g. big_pickle, gemini_flash_lite)")
    parser.add_argument("--qa", help="Override QA model ID or short key")
    parser.add_argument("--reviewer", help="Override Reviewer model ID or short key")
    parser.add_argument("--postmortem", help="Override Postmortem model ID or short key")
    parser.add_argument("--force-qa-gen", action="store_true", help="既存の動的テストファイルが存在してもQA-Genを強制再実行する（デフォルトはスキップ）")
    parser.add_argument("--test-runner", choices=["vitest", "playwright"], default="vitest", help="Test runner to use for the dynamic TDD tests (default: vitest)")
    parser.add_argument("--code-review-only", "--no-video", "--no-gui", dest="code_review_only", action="store_true", help="動画録画(Gate B)をスキップし、git diff と仕様書のAIコード直接審査(Gate C)で進行する")
    parser.add_argument("--skip-red-check", action="store_true", help="TDD Red check（実装前にテストが失敗することを検証）をスキップし、直接 Green 実装へ進む。既存コードでテストがパスしてしまう false-positive 時の緊急回避用")
    parser.add_argument("--resume", action="store_true", help="直近の running タスクから再開する。tests/dynamic.test.ts の削除をスキップし、最後の Postmortem の retry_from (coder/qa/reviewer) に基づき次ロールから厳密再開する。中断後の緊急再開用")
    parser.add_argument("--debug-mode", action="store_true", help="Enable practical mode (automatic logging for debugging)")
    args = parser.parse_args()

    setup_logging()
    LOG_DIR.mkdir(exist_ok=True)

    if not args.dry_run:
        concurrent = detect_concurrent_orchestrators()
        if concurrent:
            log.warning(
                "⚠ 別の orchestrator.py が稼働中の可能性があります (PID: %s)。",
                concurrent,
            )
            if not args.non_interactive and sys.stdin.isatty():
                ans = input("他の orchestrator が稼働中です。[A]bort / [C]ontinue ? ").strip().lower()
                if ans != "c":
                    log.info("ユーザーが中止を選択しました。")
                    sys.exit(1)
            log.info("続行します。")

    if args.reset_state and STATE_FILE.exists():
        STATE_FILE.unlink()
        log.info("Reset state file.")

    if args.reset_task:
        tid = args.reset_task.strip().upper()
        # 案1: タスク固有のソース変更だけを巻き戻す。orchestrator.py や設定・状態・ツーリング（メタ）は絶対に巻き戻さない。
        META_COPY = {"orchestrator.py", "orchestrator_state.json", "orchestrator.log",
                     "tasks.json", "AGENTS.md", "playwright.config.ts", "vitest.config.ts",
                     ".gitignore", "package.json", "package-lock.json"}
        log.info("Resetting task %s to its start checkpoint (orchestrator/config preserved)...", tid)

        code, log_out, _ = run_cmd_pgid_stream(["git", "log", f"--grep=wip({tid}): start", "--format=%H"], timeout=10)
        commits = [line.strip() for line in log_out.splitlines() if line.strip()]
        if not commits:
            log.warning("No git commit checkpoint matching 'wip(%s): start' found. Performing partial reset only (state + test files).", tid)
        else:
            start_commit = commits[-1]
            log.info("Start checkpoint commit for %s: %s", tid, start_commit)
            # 開始コミットに存在する全トラック済みファイルをNUL区切りで列挙（特殊文字/空白を含むパスも正しく扱う）
            try:
                ls_proc = subprocess.run(
                    ["git", "ls-tree", "-z", "-r", "--name-only", start_commit],
                    capture_output=True, text=False, cwd=str(ROOT),
                )
                raw_paths = ls_proc.stdout.decode("utf-8", errors="replace").split("\0")
                paths_to_restore = [p for p in raw_paths if p.strip() and p not in META_COPY]
            except Exception as exc:
                log.error("Failed to list files at start commit: %s", exc)
                paths_to_restore = []
            if paths_to_restore:
                # パスに空白や特殊文字を含む場合があるため、--pathspec-from-file で安全に復元する
                tmpfile = ROOT / ".reset_task_paths.txt"
                tmpfile.write_text("\n".join(paths_to_restore) + "\n", encoding="utf-8")
                try:
                    run_cmd_pgid_stream(
                        ["git", "checkout", start_commit, "--pathspec-from-file", str(tmpfile)],
                        timeout=30,
                    )
                    log.info("Rolled back %d task-owned file(s) to start checkpoint (orchestrator/config preserved).", len(paths_to_restore))
                finally:
                    tmpfile.unlink(missing_ok=True)
            # タスク開始後に追加された未トラックのタスク関連ファイル（tests/ など）を掃除
            run_cmd_pgid_stream(["git", "clean", "-fd", "--", "src", "tests", "docs", "public", "index.html"], timeout=30)

        # ステータスを pending に初期化（メタ状態ファイルは維持したまま該当タスクだけリセット）
        state = load_state()
        state.setdefault("tasks", {})[tid] = {"status": "pending", "attempts": 0, "cycles": 0}
        save_state(state)
        log.info("Reset task %s status in orchestrator_state.json to pending.", tid)

        for f in [ROOT / "tests" / "dynamic.spec.ts", ROOT / "tests" / "dynamic.test.ts"]:
            if f.exists():
                f.unlink()
                log.info("Removed %s", f.name)
        for gf in (ROOT / "tests").glob(f".gateb_{tid}.*"):
            gf.unlink()
            log.info("Removed golden file %s", gf.name)

        print(f"\n{GREEN}Successfully reset task {tid} to its start checkpoint.{RESET}\n")

        # --only/--range と併用した場合はリセット後そのままタスク実行へ進む（1コマンドでリセット→実行）
        running_now = bool(args.only) or bool(args.range)
        if not running_now:
            sys.exit(0)

    all_tasks = topo_sort(load_tasks())
    tasks_by_id = {t.id: t for t in all_tasks}
    state = load_state()

    # --resume: auto-select most recent running task and keep its state
    if getattr(args, "resume", False):
        running = [(tid, s) for tid, s in state.get("tasks", {}).items() if s.get("status") == "running"]
        if not running:
            log.error("--resume: no running task found in orchestrator_state.json")
            sys.exit(1)
        # pick most recently started
        resume_tid = max(running, key=lambda kv: kv[1].get("started", 0))[0]
        if args.only and args.only != resume_tid:
            log.warning("--resume --only %s conflicts with auto-resume %s; using --only=%s", args.only, resume_tid, args.only)
        elif args.range:
            log.warning("--resume with --range is ambiguous; --resume takes precedence for task selection, ignoring range")
            # keep resume_tid as single target
            args.range = None
            args.only = resume_tid
            log.info("--resume: auto-selected %s (most recent running)", resume_tid)
        elif not args.only:
            args.only = resume_tid
            log.info("--resume: auto-selected %s (most recent running, %d running candidates)", resume_tid, len(running))
        else:
            log.info("--resume: resuming %s", args.only)
        # also imply keep-dynamic-test behavior handled in exec_task

    if args.only:
        target_tasks = [t for t in all_tasks if t.id == args.only]
    else:
        start_idx = 0
        end_idx = len(all_tasks)
        if args.range:
            start_id, end_id = args.range
            sidx = next((i for i, t in enumerate(all_tasks) if t.id == start_id), None)
            if sidx is None:
                log.error("Start task '%s' not found in DAG.", start_id)
                sys.exit(1)
            start_idx = sidx

            eidx = next((i for i, t in enumerate(all_tasks) if t.id == end_id), None)
            if eidx is None:
                log.error("End task '%s' not found in DAG.", end_id)
                sys.exit(1)
            end_idx = eidx + 1

        if start_idx >= end_idx:
            log.error("Invalid range: --range '%s' comes after '%s' in DAG.", args.range[0], args.range[1])
            sys.exit(1)

        target_tasks = all_tasks[start_idx:end_idx]

    target_ids = [t.id for t in target_tasks]
    all_needed_ancestors = get_task_ancestors(tasks_by_id, target_ids)
    missing_deps = []
    for dep_id in all_needed_ancestors:
        if dep_id not in target_ids:
            dep_status = state["tasks"].get(dep_id, {}).get("status")
            if dep_status != "passed":
                missing_deps.append(f"{dep_id} (status: {dep_status})")

    if missing_deps:
        log.warning("Selected range has unpassed prerequisite dependencies: %s", ", ".join(missing_deps))
        print(f"\n{YELLOW}{BOLD}[DEPENDENCY WARNING]{RESET} The following prerequisites are not marked as 'passed':")
        for md in missing_deps:
            print(f"  {YELLOW}•{RESET} {md}")
        cont = input(f"\nProceed anyway? ({BOLD}y/N{RESET}): ").strip().lower()
        if cont != "y":
            sys.exit(1)

    # Determine FlowModels (interactive vs persisted/non-interactive vs CLI override)
    if args.non_interactive or args.dry_run:
        if "models" in state and isinstance(state["models"], dict):
            models = FlowModels.from_dict(state["models"])
        else:
            models = FlowModels()
    else:
        models = interactive_model_selection(code_review_only=args.code_review_only)

    # Apply CLI overrides if provided
    if args.coder:
        models.coder = resolve_model_id(args.coder)
    if args.qa:
        models.qa = resolve_model_id(args.qa)
    if args.reviewer:
        models.reviewer = resolve_model_id(args.reviewer)
    if args.postmortem:
        models.postmortem = resolve_model_id(args.postmortem)

    # Persist active models into state
    state["models"] = models.to_dict()
    save_state(state)

    print(f"\n{GRAY}─── Active AI Configuration ────────────────────────────────────────{RESET}")
    print(f"  {BOLD}1. Coder{RESET}      : {CYAN}{get_model_display(models.coder)}{RESET}")
    if args.code_review_only:
        print(f"  {BOLD}2. Code Reviewer{RESET} : {CYAN}{get_model_display(models.reviewer)}{RESET}")
        print(f"  {BOLD}3. Postmortem{RESET}    : {CYAN}{get_model_display(models.postmortem)}{RESET}")
    else:
        print(f"  {BOLD}2. QA Test{RESET}       : {CYAN}{get_model_display(models.qa)}{RESET}")
        print(f"  {BOLD}3. Code Reviewer{RESET} : {CYAN}{get_model_display(models.reviewer)}{RESET}")
        print(f"  {BOLD}4. Postmortem{RESET}    : {CYAN}{get_model_display(models.postmortem)}{RESET}")
    print(f"{GRAY}────────────────────────────────────────────────────────────────────{RESET}")

    if not args.dry_run:
        if not perform_preflight_checks(models, code_review_only=args.code_review_only):
            log.warning("Health check aborted by user.")
            sys.exit(1)

    log.info("Orchestrator range execution: %d tasks (from=%s, to=%s, budget=%dm)", 
             len(target_tasks), 
             (args.range[0] if args.range else target_tasks[0].id), 
             (args.range[1] if args.range else target_tasks[-1].id), 
             args.budget_min)

    if args.dry_run:
        for t in target_tasks:
            log.info("  Plan: %s <- %s", t.id, t.desc)
        return

    # Safety Guard: Never allow --force across the entire repository without explicit --only or --range
    if args.force and not args.only and not args.range:
        log.error("SAFETY ERROR: `--force` cannot be run across all tasks simultaneously (risk of cascading overwrite).")
        log.error("Please specify `--only <TID>` or `--range <FROM> <TO>` to target specific tasks.")
        sys.exit(1)

    # Protected foundational tasks that should NEVER be rerun once passed (e.g. initial scaffolding)
    PERMANENTLY_PROTECTED_TASKS = {"T00", "T82"}

    start_time = time.time()
    deadline = start_time + args.budget_min * 60

    try:
        for t in target_tasks:
            if time.time() > deadline:
                log.error("Total budget exceeded.")
                break

            if state.get("consecutive_no_action", 0) >= 3:
                log.critical("Killswitch triggered due to 3 consecutive no-action (empty output).")
                sys.exit(1)

            st = state["tasks"].get(t.id, {})
            is_passed = st.get("status") == "passed"

            if is_passed:
                if t.id in PERMANENTLY_PROTECTED_TASKS:
                    log.info("[%s] Foundational task permanently complete -> Skip", t.id)
                    continue
                if not args.force:
                    log.info("[%s] Already passed -> Skip", t.id)
                    continue

            res = exec_task(t, state, models, args, fresh_sessions=args.fresh_sessions)
            if res != "passed" and not args.force:
                log.warning("Task %s did not pass (%s). Stopping range.", t.id, res)
                break

        print(f"\n{GREEN}{BOLD}=== Range execution finished ([{target_tasks[0].id}] -> [{target_tasks[-1].id}]) ==={RESET}\n")

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
