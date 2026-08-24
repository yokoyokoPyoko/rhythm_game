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

DEV_URL = os.environ.get("DEV_URL", "http://127.0.0.1:5173/")
DEFAULT_BUDGET_MIN = 600

# モデル定義カタログ (表示名, プロバイダ, モデルID)
MODEL_CATALOG = {
    "qwen38": ("Qwen3.8-27B", "Cloudflare Workers AI", "cloudflare-workers-ai/@cf/qwen/qwen3.8-27b"),
    "nemotron_ultra": ("Nemotron 3 Ultra", "OpenCode Zen (Free)", "opencode/nemotron-3-ultra-free"),
    "deepseek_r1": ("DeepSeek-R1-Distill-Qwen-32B", "Cloudflare Workers AI", "cloudflare-workers-ai/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"),
    "laguna_free": ("Hy3 Free", "OpenCode Zen (Free)", "opencode/hy3-free"),
    "gemini_flash_lite": ("Gemini 3.5 Flash-Lite", "Google AI Studio", "google/gemini-3.5-flash-lite"),
}

CODER_OPTIONS = [
    ("qwen38", "[Cloudflare] Qwen3.8-27B", "Rank 1: 高速・高精度 TypeScript コード生成"),
    ("nemotron_ultra", "[OpenCode Zen] Nemotron 3 Ultra", "Rank 2: 豊富なコード知識・大規模MoE"),
    ("deepseek_r1", "[Cloudflare] DeepSeek-R1-Distill-Qwen-32B", "Rank 3: 高度論理思考・長考型"),
    ("gemini_flash_lite", "[Google] Gemini 3.5 Flash-Lite", "爆速枠: 待ち時間最小・超安定"),
    ("laguna_free", "[OpenCode Zen] Hy3 Free", "自律枠: 完全無料・自律コード生成"),
]

QA_OPTIONS = [
    ("qwen38", "[Cloudflare] Qwen3.8-27B", "Rank 1: ブラウザ自律操作・動画録画テスト生成"),
    ("nemotron_ultra", "[OpenCode Zen] Nemotron 3 Ultra", "Rank 2: 論理的テストケース網羅・動画テスト生成"),
    ("deepseek_r1", "[Cloudflare] DeepSeek-R1-Distill-Qwen-32B", "Rank 3: 高難度ロジック検証・長考テスト生成"),
    ("gemini_flash_lite", "[Google] Gemini 3.5 Flash-Lite", "爆速枠: 即時動画テスト生成"),
    ("laguna_free", "[OpenCode Zen] Hy3 Free", "自律枠: 完全無料・自律動画テスト生成"),
]

REVIEWER_OPTIONS = [
    ("gemini_flash_lite", "[Google] Gemini 3.5 Flash-Lite", "動画審査: .webm 動画を直接解析 (Gemini 固定)"),
]

POSTMORTEM_OPTIONS = [
    ("nemotron_ultra", "[OpenCode Zen] Nemotron 3 Ultra", "Rank 1: 推論特化・根本原因究明"),
    ("qwen38", "[Cloudflare] Qwen3.8-27B", "Rank 2: 最新TS仕様知識+熟考"),
    ("gemini_flash_lite", "[Google] Gemini 3.5 Flash-Lite", "爆速枠: 即時エラー要約"),
    ("laguna_free", "[OpenCode Zen] Hy3 Free", "自律枠: 完全無料・自律原因分析"),
]

BACKOFF_DELAYS = [5, 10, 30, 60, 120]

log = logging.getLogger("orchestrator")


@dataclass
class FlowModels:
    coder: str = MODEL_CATALOG["qwen38"][2]
    qa: str = MODEL_CATALOG["qwen38"][2]
    reviewer: str = MODEL_CATALOG["gemini_flash_lite"][2]
    postmortem: str = MODEL_CATALOG["nemotron_ultra"][2]


@dataclass
class Task:
    id: str
    desc: str
    depends_on: list[str] = field(default_factory=list)
    ui: bool = False


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


def perform_preflight_checks(models: FlowModels) -> bool:
    print("\n" + f"{GRAY}─── Pre-flight Health Check ────────────────────────────────────────{RESET}")
    all_ok = True
    checked: set[str] = set()

    for label, m in [("1. Coder", models.coder), ("2. QA", models.qa), ("3. Reviewer", models.reviewer), ("4. Postmortem", models.postmortem)]:
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


def interactive_model_selection() -> FlowModels:
    print("\n" + f"{INDIGO}{BOLD}TRACE WAVE // Autonomous Orchestrator{RESET}")
    print(f"{GRAY}────────────────────────────────────────────────────────────────────{RESET}")
    print(f"  {BOLD}[1]{RESET} {GREEN}Recommended Preset{RESET} (Rank 1 Models)")
    print(f"      {GRAY}├─ 1. Coder      :{RESET} {GRAY}[Cloudflare]{RESET} {CYAN}Qwen3.8-27B{RESET}")
    print(f"      {GRAY}├─ 2. QA Test    :{RESET} {GRAY}[Cloudflare]{RESET} {CYAN}Qwen3.8-27B{RESET}")
    print(f"      {GRAY}├─ 3. Reviewer   :{RESET} {GRAY}[Google]{RESET} {CYAN}Gemini 3.5 Flash-Lite{RESET}")
    print(f"      {GRAY}└─ 4. Postmortem :{RESET} {GRAY}[Cloudflare]{RESET} {CYAN}DeepSeek-R1-Distill-Qwen-32B{RESET}")
    print(f"  {BOLD}[2]{RESET} {YELLOW}Ultra-Fast Preset{RESET} (Gemini 3.5 Flash-Lite Unified) {GRAY}[Google]{RESET}")
    print(f"  {BOLD}[3]{RESET} {DIM}Custom Configuration{RESET} (Select each model manually)")
    print(f"{GRAY}────────────────────────────────────────────────────────────────────{RESET}")

    choice = input(f"Select preset [{BOLD}1{RESET}]: ").strip()

    if choice == "" or choice == "1":
        print(f"{GREEN}>> Applied: Recommended Preset{RESET}")
        return FlowModels(
            coder=MODEL_CATALOG["qwen38"][2],
            qa=MODEL_CATALOG["qwen38"][2],
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

    coder_m = select_one("Select [1. Coder]:", CODER_OPTIONS, "qwen38")
    qa_m = select_one("Select [2. QA Test Generator]:", QA_OPTIONS, "qwen38")
    rev_m = select_one("Select [3. Dynamic Reviewer]:", REVIEWER_OPTIONS, "gemini_flash_lite")
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
            ui=bool(item.get("ui", False)),
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
) -> tuple[int, str]:
    session_id = None
    title = None
    if task_id and role and state is not None:
        title = f"[{task_id}] {role.capitalize()}"
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

        if "429" in out or "Too Many Requests" in out:
            log.warning("429 Too Many Requests. Backoff %ds...", delay)
            time.sleep(delay)
            continue

        return code, out

    if out.strip() != "":
        return 0, out

    log.error("Retry limit exceeded for %s (empty output)", label)
    return -1, out


def extract_compact_spec(task_id: str) -> str:
    if not AGENTS_MD.exists():
        return ""
    text = AGENTS_MD.read_text(encoding="utf-8")
    pattern = rf"### \[?{task_id}\]?.*?(?=\n### \[?T\d+\]?|\n## |\Z)"
    match = re.search(pattern, text, re.S)
    return match.group(0).strip() if match else f"Task {task_id} specification"


def get_recent_postmortem_rules() -> str:
    if POSTMORTEM_FILE.exists():
        pm_text = POSTMORTEM_FILE.read_text(encoding="utf-8")
        matches = re.findall(r'"prohibited_rule":\s*"([^"]+)"', pm_text)
        if matches:
            return "\n【Prohibited Rules from Past Failures】:\n" + "\n".join(f"- {r}" for r in matches[-3:])
    return ""


def build_compact_coder_prompt(task: Task) -> str:
    spec = extract_compact_spec(task.id)
    recent_rules = get_recent_postmortem_rules()

    return f"""Implement the following task. No questions allowed.

Task: {task.id} - {task.desc}

Specification:
{spec}
{recent_rules}

Constraints:
- Ensure zero TypeScript compiler errors (`tsc --noEmit`).
- Strict minimal dark theme (Linear/Vercel style). No gaming/RGB glows.
- Output 'DONE' upon completion.
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


def generate_and_run_gate_b(task: Task, qa_model: str, state: dict[str, Any] | None = None, fresh_sessions: bool = False) -> GateResult:
    if not task.ui or not has_dev_script():
        return GateResult("Gate B (Dynamic Test)", True, f"Task {task.id} (ui={task.ui}) -> Skip dynamic browser test")

    if not ensure_dev_server():
        return GateResult("Gate B (Dynamic Test)", False, "Dev server failed to start")

    SCREENSHOT_DIR.mkdir(exist_ok=True)
    VIDEO_DIR.mkdir(exist_ok=True)
    spec = extract_compact_spec(task.id)
    recent_rules = get_recent_postmortem_rules()

    if state and task.id in state.get("tasks", {}):
        state["tasks"][task.id].setdefault("sessions", {})["qa"] = None

    prompt = f"""Write a thorough, interactive Playwright (TypeScript) automated browser test script for task {task.id} ({task.desc}), and save it DIRECTLY to `tests/dynamic.spec.ts` using your file-write tool.

Context:
This test execution automatically records a video (.webm) of the browser in action. The recorded video is inspected by an uncompromising Product Director / Senior UX/UI Critic (Gate C Reviewer) to evaluate visual polish, fluidity, and interaction craftsmanship.

Specification from AGENTS.md:
{spec}
{recent_rules}

STRICT QA REQUIREMENTS FOR VIDEO CAPTURE:
1. Comprehensive Interaction: Do not just load the page. Actively simulate realistic, thorough user interactions for ALL features mentioned in the specification (e.g., clicking specific buttons, navigating routes, inputting data, testing shortcuts).
   - This app uses HashRouter under a Vite dev server (Playwright baseURL is pre-configured). Use `page.goto('/')` and navigate routes via `await page.evaluate(() => {{ window.location.hash = '#/editor'; }})` style hash navigation.
2. Visual Capture Timing: Insert adequate wait times (`page.waitForTimeout(1500-3000)` between critical actions) so that CSS transitions, animations, hover states, and dynamic state updates are clearly and smoothly captured in the recorded video.
3. Robust Locators & Stability: Use robust locators (e.g., text, roles, specific test IDs or classes). Avoid strict container visibility checks if 0-height.
4. Console Error Monitoring: Listen to unhandled console exceptions and fail if any uncaught TypeError/ReferenceError occurs.
5. Single File Rule: You MUST write the complete final test to `tests/dynamic.spec.ts`. Do NOT modify any other file. Do NOT run the test yourself.
6. Test Timeout Management: Playwright's default test timeout is 30 seconds (30000ms). If total operations, animations, or waitForTimeout delays might exceed 30 seconds, you MUST explicitly set an appropriate test timeout at the start of the test block using `test.setTimeout(60000)` or `test.setTimeout(120000)`.

Investigate as many source files as you need before writing. When you have finished writing `tests/dynamic.spec.ts`, output only: DONE
"""
    QA_CONTINUE_RETRIES = 5
    continuation_prompt = (
        prompt
        + "\n\n[CONTINUATION] 前回の実行では tests/dynamic.spec.ts を実際に書いていません"
        "（書き込み完了前に終わりました）。今度は file-write ツールで tests/dynamic.spec.ts を"
        "「今すぐ直接」書いてください。説明だけでなく実際に書くこと。書き終わったら DONE のみ出力。"
    )

    cont_prompt = prompt
    for attempt in range(1, QA_CONTINUE_RETRIES + 1):
        mtime_before = DYNAMIC_SPEC_FILE.stat().st_mtime if DYNAMIC_SPEC_FILE.exists() else 0.0
        if attempt == 1:
            log.info("QA generating dynamic test script (direct write mode)...")
        else:
            log.info("QA did not write tests/dynamic.spec.ts (stopped partway). Continuing (attempt %d/%d)...", attempt, QA_CONTINUE_RETRIES)
            cont_prompt = continuation_prompt
        _, out = run_opencode_with_retry(
            qa_model, cont_prompt, timeout=None, label="QA-Gen", variant="max",
            task_id=task.id, role="qa", state=state, fresh_sessions=fresh_sessions
        )

        wrote_spec = DYNAMIC_SPEC_FILE.exists() and DYNAMIC_SPEC_FILE.stat().st_mtime > mtime_before
        if wrote_spec:
            log.info("QA model wrote tests/dynamic.spec.ts directly.")
            break
    else:
        return GateResult(
            "Gate B (Dynamic Test)",
            False,
            "QA model did not write tests/dynamic.spec.ts after 5 continues",
            fatal=True,
        )
    log.info("Running Playwright execution with Video Recording...")

    code, test_out, _ = run_cmd_pgid_stream(["npx", "playwright", "test", "tests/dynamic.spec.ts"], timeout=None, prefix="playwright: ")
    if code != 0:
        fatal_lines = [l for l in test_out.splitlines() if re.search(r"Error:|failed|Timed out", l)]
        detail = "\n".join(fatal_lines) if fatal_lines else test_out[-1000:]
        return GateResult("Gate B (Dynamic Test)", False, detail)

    # 録画された .webm 動画ファイルを探索
    videos = sorted(list(VIDEO_DIR.glob("**/*.webm")), key=lambda p: p.stat().st_mtime)
    log.info("Playwright execution completed (%d video recording(s) captured).", len(videos))
    return GateResult("Gate B (Dynamic Test)", True, f"PASS ({len(videos)} video(s) recorded)")


def run_llm_cli_video_review(video_path: Path, prompt: str, timeout: int | None = None) -> tuple[int, str]:
    cmd = ["llm", "-m", "gemini-3.5-flash-lite", "-o", "thinking_level", "high", "-a", str(video_path), prompt]
    log.info("Dispatching Video Review via Simon Willison's llm CLI (model=gemini-3.5-flash-lite, video=%s)...", video_path.name)
    print(f"  {GRAY}┌─ Start: llm CLI Video Review ──────────────────────────────{RESET}", flush=True)
    code, out, timed_out = run_cmd_pgid_stream(cmd, timeout=timeout, prefix=f"{CYAN}::{RESET} ")
    print(f"  {GRAY}└─ End: llm CLI Video Review (exit={code}) ────────────────────────{RESET}", flush=True)
    return code, out


def check_gate_c(task: Task, reviewer_model: str) -> GateResult:
    if not task.ui or not has_dev_script():
        return GateResult("Gate C (Dynamic Review)", True, f"Task {task.id} (ui={task.ui}) -> Skip dynamic review")

    videos = sorted(list(VIDEO_DIR.glob("**/*.webm")), key=lambda p: p.stat().st_mtime)
    if not videos:
        log.error("No gameplay video recording (.webm) found for Gate C.")
        return GateResult("Gate C (Dynamic Review)", False, "No gameplay video recorded")

    latest_video = videos[-1]
    spec = extract_compact_spec(task.id)

    prompt = f"""You are an Uncompromising Product Director and Senior UX/UI Critic inspecting the browser execution video recording for task {task.id} ({task.desc}).

Specification & Intent:
{spec}

EVALUATION PHILOSOPHY:
Do not merely check if technical bullet points or bare-minimum features exist. Evaluate whether the implementation achieves high-end product polish, delightful user experience (UX), and refined visual craftsmanship. If a feature technically works but feels crude, janky, unpolished, or visually unappealing, it fails.

MANDATORY EXCELLENCE CRITERIA (All must be met for a PASS):
1. Fluidity & Responsiveness: Interactions and animations must be butter-smooth, responsive, and completely free of stutter, jank, or frozen states.
2. Visual Polish & Hierarchy: Clean typography, precise spacing, consistent styling, and professional aesthetic (no raw unstyled defaults or ugly overlapping).
3. Feedback & State Clarity: Clear, immediate visual feedback for user actions; accurate data presentation without flickering or visual artifacts.
4. Craft & Delight: The implementation should feel like a finished, polished product ready for users, demonstrating thoughtful care beyond mere functional compliance.

SCORE TIERS & VERDICT (Binary Gate):
- [80 - 100 pts] PASS: Outstanding execution. Fully functional, highly polished, visually refined, and delivers an exceptional user experience with zero noticeable flaws.
- [0 - 79 pts]   FAIL (Immediate Rejection): Any jank, crude UI, missing polish, unresponsive feedback, design inconsistency, or superficial implementation that fails to deliver a truly finished product experience.

Output JSON only:
{{"score": 90, "verdict": "PASS", "comment": "detailed product/UX critique"}} or {{"score": 50, "verdict": "FAIL", "comment": "specific UX/polish flaw observed"}}
"""
    log.info("Reviewer (Gemini Video AI via llm CLI) analyzing video: %s...", latest_video.name)
    code, out = run_llm_cli_video_review(latest_video, prompt, timeout=None)
    
    if code != 0:
        log.error("Reviewer model failed/timed out. Rejecting Gate C.")
        return GateResult("Gate C (Dynamic Review)", False, f"Reviewer model execution failed (exit={code})")

    match = re.search(r'\{.*"score".*"verdict".*\}', out, re.S)
    if match:
        try:
            res = json.loads(match.group(0))
            score = res.get("score", 0)
            verdict = res.get("verdict", "FAIL")
            comment = res.get("comment", "")
            ok = score >= 80 and verdict == "PASS"
            score_color = GREEN if ok else RED
            log.info("Review Verdict: %s%s (%d/100)%s | Reason: %s", score_color, verdict, score, RESET, comment)
            return GateResult("Gate C (Dynamic Review)", ok, f"Score={score}, Verdict={verdict}: {comment}")
        except Exception:
            pass

    log.error("Reviewer response did not contain valid evaluation JSON.")
    return GateResult("Gate C (Dynamic Review)", False, "Reviewer output format invalid")


def decode_retry_from(pm: Any, coder_commit: str | None) -> str:
    if isinstance(pm, dict) and pm.get("retry_from") == "qa" and coder_commit:
        return "qa"
    return "coder"


def _extract_postmortem_json(out: str) -> dict | None:
    m = re.search(r'\{[^{}]*"retry_from"[^{}]*\}', out, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    for m in re.findall(r'\{.*?\}', out, re.S):
        try:
            d = json.loads(m)
            if isinstance(d, dict) and "retry_from" in d:
                return d
        except Exception:
            continue
    idx = out.find('"retry_from"')
    if idx != -1:
        s, e = out.rfind('{', 0, idx), out.find('}', idx)
        if s != -1 and e != -1:
            try:
                return json.loads(out[s:e + 1])
            except Exception:
                pass
    return None


def generate_postmortem(task: Task, error_detail: str, postmortem_model: str, state: dict[str, Any] | None = None, fresh_sessions: bool = False) -> dict:
    POSTMORTEM_DIR.mkdir(exist_ok=True)
    if state and task.id in state.get("tasks", {}):
        state["tasks"][task.id].setdefault("sessions", {})["postmortem"] = None
    prompt = f"""Analyze the failure for task {task.id}. Determine root cause and generate a strict prohibited rule for next attempt.

Failure Log:
{error_detail[:1000]}

Decide where the next retry should restart from:
- "coder": the failure is due to the implementation code (Coder output) and it must be regenerated.
- "qa": the implementation code is acceptable but the dynamic test / verification approach (QA-Gen test script or how it was exercised) was flawed; reuse the Coder output and regenerate only the test.

Output JSON only:
{{
  "approach": "approach taken",
  "root_cause": "root cause",
  "prohibited_rule": "prohibited rule for next run",
  "retry_from": "coder" or "qa"
}}
"""
    log.info("Postmortem analyzing failure and formulating rules...")
    _, out = run_opencode_with_retry(
        postmortem_model, prompt, timeout=None, label="Postmortem", variant="max",
        task_id=task.id, role="postmortem", state=state, fresh_sessions=fresh_sessions
    )

    entry = f"\n### [{time.strftime('%Y-%m-%d %H:%M:%S')}] Task {task.id} Failure\n```\n{out}\n```\n"
    with open(POSTMORTEM_FILE, "a", encoding="utf-8") as f:
        f.write(entry)
    log.info("Updated POSTMORTEM.md.")

    data = _extract_postmortem_json(out)
    if data:
        return {
            "approach": data.get("approach", ""),
            "root_cause": data.get("root_cause", ""),
            "rule": data.get("prohibited_rule", ""),
            "retry_from": data.get("retry_from", "coder"),
        }
    log.warning("Postmortem JSON parse failed; defaulting retry_from=coder. Raw head: %s", out[:400])
    return {"approach": "", "root_cause": "", "rule": "", "retry_from": "coder"}


def git_checkpoint(message: str) -> None:
    run_cmd_pgid_stream(["git", "add", "-A"])
    run_cmd_pgid_stream(["git", "commit", "-m", message, "--allow-empty"])


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
    need_coder = True
    coder_commit = None

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
        nonlocal cycles, no_progress_streak, need_coder
        if no_progress_streak >= NO_PROGRESS_LIMIT:
            cycles += 1
            no_progress_streak = 0
            need_coder = True
            log.warning("[%s] %d consecutive attempts without progress. Rolling back to task-start commit and restarting cycle (%d/%d).", task.id, NO_PROGRESS_LIMIT, cycles, MAX_CYCLES)
            git_rollback(head_hash)

    while cycles < MAX_CYCLES:
        st["attempts"] = st.get("attempts", 0) + 1
        st["cycles"] = cycles + 1
        save_state(state)
        log.info("Starting implementation [%s] (attempt %d, cycle %d/%d)", task.id, st["attempts"], cycles + 1, MAX_CYCLES)

        # 1. Coder (+ Gate A) — skipped when retrying from QA-Gen
        if need_coder:
            if state and task.id in state.get("tasks", {}):
                state["tasks"][task.id].setdefault("sessions", {})["coder"] = None
            prompt = build_compact_coder_prompt(task)
            code, out = run_opencode_with_retry(
                models.coder, prompt, timeout=None, label=f"Coder({task.id})", variant="medium",
                task_id=task.id, role="coder", state=state, fresh_sessions=fresh_sessions
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
        else:
            log.info("[%s] Reusing Coder output (retry from QA-Gen). Skipping Coder + Gate A.", task.id)

        # 3. Gate B (Playwright)
        gb = generate_and_run_gate_b(task, models.qa, state=state, fresh_sessions=fresh_sessions)
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
                log.info("[%s] Postmortem: retry from QA-Gen (reuse Coder output).", task.id)
                need_coder = False
            else:
                need_coder = True
            mark_stage(1)
            maybe_reset_cycle()
            continue
        log.info("[%s] %sGate B (Dynamic Test) PASS%s", task.id, GREEN, RESET)
        git_checkpoint(f"checkpoint({task.id}, gate-b)")

        # 4. Gate C (Reviewer)
        gc = check_gate_c(task, models.reviewer)
        if not gc.ok:
            log.error("[%s] Gate C failed: %s", task.id, gc.detail)
            pm = generate_postmortem(task, f"Gate C (Dynamic Review) failed:\n{gc.detail}", models.postmortem, state=state, fresh_sessions=fresh_sessions)
            if decode_retry_from(pm, coder_commit) == "qa":
                log.info("[%s] Postmortem: retry from QA-Gen (reuse Coder output).", task.id)
                need_coder = False
            else:
                need_coder = True
            mark_stage(2)
            maybe_reset_cycle()
            continue
        log.info("[%s] %sGate C (Dynamic Review) PASS%s", task.id, GREEN, RESET)

        # Complete
        git_checkpoint(f"feat({task.id}): complete")
        st["status"] = "passed"
        st["finished"] = time.time()
        state["consecutive_no_action"] = 0
        save_state(state)
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
    others: list[int] = []
    proc_root = Path("/proc")
    if not proc_root.exists():
        return others
    for entry in proc_root.iterdir():
        name = entry.name
        if not name.isdigit():
            continue
        pid = int(name)
        if pid == me:
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes()
        except (OSError, PermissionError):
            continue
        if not cmdline:
            continue
        if any(b"orchestrator.py" in part for part in cmdline.split(b"\x00")):
            others.append(pid)
    return others


def main() -> None:
    parser = argparse.ArgumentParser(description="Trace Wave Autonomous Orchestrator (Modern CLI)")
    parser.add_argument("--dry-run", action="store_true", help="Display execution plan only")
    parser.add_argument("--only", metavar="TID", help="Execute specific task ID")
    parser.add_argument("--from", dest="start_from", metavar="TID", help="区間の開始タスクID")
    parser.add_argument("--to", dest="end_at", metavar="TID", help="区間の終了タスクID (このタスク完了後に自動停止)")
    parser.add_argument("--force", action="store_true", help="Force re-execution of passed tasks")
    parser.add_argument("--step", action="store_true", help="1タスク完了ごとにEnterキー確認を挟む（ステップ実行モード）")
    parser.add_argument("--reset-state", action="store_true", help="Reset state file")
    parser.add_argument("--budget-min", type=int, default=DEFAULT_BUDGET_MIN, help="Total budget in minutes")
    parser.add_argument("--non-interactive", action="store_true", help="Skip interactive model selector")
    parser.add_argument("--fresh-sessions", action="store_true", help="Always create fresh OpenCode sessions for tasks (ignoring past sessions)")
    args = parser.parse_args()

    setup_logging()
    LOG_DIR.mkdir(exist_ok=True)

    concurrent = detect_concurrent_orchestrators()
    if concurrent:
        log.warning(
            "⚠ 別の orchestrator.py が既に稼働中です (PID: %s)。"
            "同時実行は port 5173 の奪い合い等を引き起こします。",
            concurrent,
        )
        if not sys.stdin.isatty():
            log.error("非対話環境のため中止します。")
            sys.exit(1)
        ans = input("他の orchestrator が稼働中です。[A]bort / [C]ontinue ? ").strip().lower()
        if ans != "c":
            log.info("ユーザーが中止を選択しました。")
            sys.exit(1)
        log.info("続行します。")

    if args.reset_state and STATE_FILE.exists():
        STATE_FILE.unlink()
        log.info("Reset state file.")

    all_tasks = topo_sort(load_tasks())
    tasks_by_id = {t.id: t for t in all_tasks}
    state = load_state()

    if args.only:
        target_tasks = [t for t in all_tasks if t.id == args.only]
    else:
        start_idx = 0
        end_idx = len(all_tasks)
        if args.start_from:
            idx = next((i for i, t in enumerate(all_tasks) if t.id == args.start_from), None)
            if idx is None:
                log.error("Start task '%s' not found in DAG.", args.start_from)
                sys.exit(1)
            start_idx = idx

        if args.end_at:
            idx = next((i for i, t in enumerate(all_tasks) if t.id == args.end_at), None)
            if idx is None:
                log.error("End task '%s' not found in DAG.", args.end_at)
                sys.exit(1)
            end_idx = idx + 1

        if start_idx >= end_idx:
            log.error("Invalid range: --from '%s' comes after --to '%s' in DAG.", args.start_from, args.end_at)
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

    if args.non_interactive or args.dry_run:
        models = FlowModels()
    else:
        models = interactive_model_selection()

    print(f"\n{GRAY}─── Active AI Configuration ────────────────────────────────────────{RESET}")
    print(f"  {BOLD}1. Coder{RESET}      : {CYAN}{get_model_display(models.coder)}{RESET}")
    print(f"  {BOLD}2. QA Test{RESET}    : {CYAN}{get_model_display(models.qa)}{RESET}")
    print(f"  {BOLD}3. Reviewer{RESET}   : {CYAN}{get_model_display(models.reviewer)}{RESET}")
    print(f"  {BOLD}4. Postmortem{RESET} : {CYAN}{get_model_display(models.postmortem)}{RESET}")
    print(f"{GRAY}────────────────────────────────────────────────────────────────────{RESET}")

    if not args.dry_run:
        if not perform_preflight_checks(models):
            log.warning("Health check aborted by user.")
            sys.exit(1)

    log.info("Orchestrator range execution: %d tasks (from=%s, to=%s, budget=%dm)", 
             len(target_tasks), 
             args.start_from or target_tasks[0].id, 
             args.end_at or target_tasks[-1].id, 
             args.budget_min)

    if args.dry_run:
        for t in target_tasks:
            log.info("  Plan: %s <- %s", t.id, t.desc)
        return

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
            if st.get("status") == "passed" and not args.force:
                log.info("[%s] Already passed -> Skip (--force to rerun)", t.id)
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
