from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .constants import (
    DEFAULT_AGENT_BIN,
    DEFAULT_AGENT_PROVIDER,
    DEFAULT_CODER_EFFORT,
    DEFAULT_CODER_MODEL,
    DEFAULT_CODER_TEMPERATURE,
    DEFAULT_LOOP_DELAY_MS,
    DEFAULT_MAX_LOOP_ITERATIONS,
    DEFAULT_MAX_TURNS,
    DEFAULT_PERMISSION_MODE,
    DEFAULT_REVIEWER_EFFORT,
    DEFAULT_REVIEWER_MODEL,
    DEFAULT_REVIEWER_TEMPERATURE,
    KNOWN_CLI_FLAGS,
    REQUIRED_ROOT_FILES,
)
from .models import (
    AgentProviderId,
    CliOptions,
    CommandResult,
    DispatchDecision,
    DispatcherRunResult,
    FeatureSummary,
    RunnerExecMode,
    RunnerConfig,
)
from .providers import AGENT_PROVIDERS, build_provider_command, resolve_agent_provider


def is_known_cli_flag(arg: str) -> bool:
    flag = arg.split("=", 1)[0]
    return flag in KNOWN_CLI_FLAGS


def split_forwarded_args(argv: list[str]) -> tuple[list[str], list[str]]:
    normalized = argv[1:] if argv and argv[0] == "--" else list(argv)
    first_sep = normalized.index("--") if "--" in normalized else -1
    if first_sep > 0 and any(is_known_cli_flag(a) for a in normalized[first_sep + 1 :]):
        normalized = normalized[:first_sep] + normalized[first_sep + 1 :]

    sep = normalized.index("--") if "--" in normalized else -1
    if sep < 0:
        return normalized, []
    return normalized[:sep], normalized[sep + 1 :]


def collect_repeated_values(argv: list[str], option_name: str) -> list[str]:
    values: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == option_name:
            i += 1
            if i >= len(argv):
                raise ValueError(f"Missing value for {option_name}")
            values.append(argv[i])
        elif arg.startswith(f"{option_name}="):
            values.append(arg[len(option_name) + 1 :])
        i += 1
    return values


def collect_last_value(argv: list[str], option_name: str) -> str | None:
    values = collect_repeated_values(argv, option_name)
    return values[-1] if values else None


def parse_non_negative_int(value: str, option_name: str) -> int:
    if not re.fullmatch(r"\d+", value):
        raise ValueError(f"{option_name} must be a non-negative integer, got: {value}")
    return int(value)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Agent dispatcher for repository feature work.")
    parser.add_argument("task_parts", nargs="*")
    parser.add_argument("--task", "-t", default=None)
    parser.add_argument("--feature", "-f", default=None)
    parser.add_argument("--runner", choices=["coder", "reviewer", "dispatcher"], default="coder")
    parser.add_argument("--model", "-m", default=None)
    parser.add_argument("--effort", default=None)
    parser.add_argument("--temperature", default=None)
    parser.add_argument("--coder-model", default=None)
    parser.add_argument("--coder-effort", default=None)
    parser.add_argument("--coder-temperature", default=None)
    parser.add_argument("--reviewer-model", default=None)
    parser.add_argument("--reviewer-effort", default=None)
    parser.add_argument("--reviewer-temperature", default=None)
    parser.add_argument("--max-turns", default=DEFAULT_MAX_TURNS)
    parser.add_argument("--permission-mode", default=DEFAULT_PERMISSION_MODE)
    parser.add_argument("--name", "-n", default=None)
    parser.add_argument("--agent-provider", choices=list(AGENT_PROVIDERS.keys()), default=DEFAULT_AGENT_PROVIDER)
    parser.add_argument("--agent-bin", default=None)
    parser.add_argument("--codex-bin", default=None, help="Legacy alias for --agent-bin with --agent-provider codex.")
    parser.add_argument("--oh-bin", default=None)
    parser.add_argument("--plan-dir", default="docs/plans")
    parser.add_argument("--layer2-ref", action="append", default=[])
    parser.add_argument("--dry-run", "--dryRun", action="store_true", dest="dry_run")
    parser.add_argument("--loop", action="store_true")
    parser.add_argument("--loop-delay-ms", default=DEFAULT_LOOP_DELAY_MS)
    parser.add_argument("--max-loop-iterations", default=DEFAULT_MAX_LOOP_ITERATIONS)
    parser.add_argument("--skip-init", "--skipInit", action="store_true", dest="skip_init")
    parser.add_argument("--continue", "-c", action="store_true", dest="continue_session")
    parser.add_argument("--resume", "-r", default=None)
    parser.add_argument("--output-format", default=None)
    parser.add_argument(
        "--dangerously-skip-permissions",
        "--dangerouslySkipPermissions",
        action="store_true",
        dest="dangerously_skip_permissions",
    )
    return parser


def to_cli_options(parsed: argparse.Namespace, raw_cli_args: list[str], extra_agent_args: list[str]) -> CliOptions:
    task = (parsed.task if isinstance(parsed.task, str) else "") or " ".join(parsed.task_parts)
    task = task.strip()
    runner = parsed.runner
    if not task and runner != "dispatcher":
        raise ValueError('Missing task. Use --task "..." or pass the task as trailing args.')

    agent_provider: AgentProviderId = resolve_agent_provider(str(parsed.agent_provider or DEFAULT_AGENT_PROVIDER))
    legacy_bin = collect_last_value(raw_cli_args, "--codex-bin") or collect_last_value(raw_cli_args, "--oh-bin")
    if legacy_bin and agent_provider != "codex":
        raise ValueError("Legacy --codex-bin/--oh-bin aliases are only valid with --agent-provider codex. Use --agent-bin instead.")

    agent_bin = (
        collect_last_value(raw_cli_args, "--agent-bin")
        or legacy_bin
        or parsed.agent_bin
        or AGENT_PROVIDERS[agent_provider].default_bin
        or DEFAULT_AGENT_BIN
    )

    return CliOptions(
        task=task or None,
        feature=parsed.feature,
        runner=runner,
        model=parsed.model,
        effort=parsed.effort,
        temperature=parsed.temperature,
        coder_model=parsed.coder_model,
        coder_effort=parsed.coder_effort,
        coder_temperature=parsed.coder_temperature,
        reviewer_model=parsed.reviewer_model,
        reviewer_effort=parsed.reviewer_effort,
        reviewer_temperature=parsed.reviewer_temperature,
        max_turns=str(parsed.max_turns),
        permission_mode=str(parsed.permission_mode),
        name=parsed.name,
        agent_provider=agent_provider,
        agent_bin=agent_bin,
        plan_dir=str(parsed.plan_dir),
        layer2_refs=collect_repeated_values(raw_cli_args, "--layer2-ref"),
        dry_run=bool(parsed.dry_run),
        loop=bool(parsed.loop),
        loop_delay_ms=str(parsed.loop_delay_ms),
        max_loop_iterations=str(parsed.max_loop_iterations),
        skip_init=bool(parsed.skip_init),
        continue_session=bool(parsed.continue_session),
        resume=parsed.resume,
        output_format=parsed.output_format,
        dangerously_skip_permissions=bool(parsed.dangerously_skip_permissions),
        extra_agent_args=extra_agent_args,
    )


def run(command: str, args: list[str], cwd: Path, timeout_ms: int = 120_000) -> CommandResult:
    proc = subprocess.run(
        [command, *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout_ms / 1000,
        check=False,
    )
    return CommandResult(
        command=" ".join([command, *args]),
        exit_code=proc.returncode,
        stdout=proc.stdout or "",
        stderr=proc.stderr or "",
    )


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def format_local_date(date: datetime | None = None) -> str:
    current = date or datetime.now(tz=ZoneInfo("Asia/Shanghai"))
    return current.strftime("%Y-%m-%d")


def write_plan_file(cwd: Path, plan_dir: str, prompt: str, runner: str) -> Path:
    absolute_dir = (cwd / plan_dir).resolve()
    absolute_dir.mkdir(parents=True, exist_ok=True)

    date = format_local_date()
    escaped_date = re.escape(date)
    escaped_runner = re.escape(runner)
    pattern = re.compile(rf"^plan-{escaped_date}-{escaped_runner}-(\d{{3}})\.md$")
    legacy_pattern = re.compile(rf"^plan-{escaped_date}-(\d{{3}})\.md$")

    used_counts: list[int] = []
    for filename in os.listdir(absolute_dir):
        match = pattern.match(filename) or legacy_pattern.match(filename)
        if match:
            used_counts.append(int(match.group(1)))

    next_count = (max(used_counts) if used_counts else 0) + 1
    file_name = f"plan-{date}-{runner}-{next_count:03d}.md"
    absolute_path = absolute_dir / file_name
    absolute_path.write_text(prompt.rstrip() + "\n", encoding="utf-8")
    return absolute_path


def tail_lines(text: str, max_lines: int) -> str:
    lines = text.rstrip().splitlines()
    return "\n".join(lines[-max_lines:])


def truncate(text: str, max_chars: int) -> str:
    if max_chars == 0 or len(text) <= max_chars:
        return text
    return f"{text[:max_chars]}\n...[truncated {len(text) - max_chars} chars]"


def extract_current_status_and_latest_session(progress: str) -> str:
    status_start = progress.find("## 当前已验证状态")
    status_end = progress.find("## 会话记录", status_start)
    if status_start >= 0:
        status = progress[status_start : status_end if status_end >= 0 else status_start + 2000]
    else:
        status = progress[:2000]

    latest_idx = progress.rfind("### Session")
    latest = progress[latest_idx:] if latest_idx >= 0 else ""
    return f"{status.strip()}\n\n--- latest session ---\n{truncate(latest.strip(), 9000)}"


def parse_feature_summaries(raw: str) -> list[FeatureSummary]:
    parsed = json.loads(raw)
    features: list[dict[str, Any]] = parsed.get("features", [])
    result: list[FeatureSummary] = []
    for feature in features:
        layer2 = feature.get("layer2_refs")
        refs = [str(ref) for ref in layer2] if isinstance(layer2, list) else []
        result.append(
            FeatureSummary(
                id=str(feature.get("id", "")),
                title=str(feature.get("title", "")),
                status=str(feature.get("status", "")),
                priority=int(feature.get("priority", 999)),
                layer2_refs=refs,
            )
        )
    return result


def read_feature_summaries(cwd: Path) -> list[FeatureSummary]:
    return parse_feature_summaries(read_text(cwd / "feature_list.json"))


def feature_by_id(features: list[FeatureSummary], feature_id: str) -> FeatureSummary | None:
    for feature in features:
        if feature.id == feature_id:
            return feature
    return None


def by_priority_then_id(feature: FeatureSummary) -> tuple[int, str]:
    return feature.priority, feature.id


def find_blocked_feature(features: list[FeatureSummary], requested: str | None = None) -> FeatureSummary | None:
    if requested:
        feature = feature_by_id(features, requested)
        return feature if feature and feature.status == "blocked" else None

    blocked = [feature for feature in features if feature.status == "blocked"]
    blocked.sort(key=by_priority_then_id)
    return blocked[0] if blocked else None


def select_feature(features: list[FeatureSummary], requested: str | None = None) -> FeatureSummary | None:
    if requested:
        found = feature_by_id(features, requested)
        if not found:
            raise ValueError(f"Requested feature not found: {requested}")
        return found

    active = [feature for feature in features if feature.status == "in_progress"]
    if len(active) > 1:
        ids = ", ".join(feature.id for feature in active)
        raise ValueError(f"Multiple in_progress features found: {ids}")
    if len(active) == 1:
        return active[0]

    pending = [feature for feature in features if feature.status != "passing"]
    pending.sort(key=lambda feature: feature.priority)
    return pending[0] if pending else None


def dispatch_task_for(feature: FeatureSummary, runner: RunnerExecMode, requested_task: str | None = None) -> str:
    if runner == "coder":
        status_contract = [
            f"Dispatcher selected feature {feature.id} ({feature.status}) - {feature.title}.",
            "Implement the feature end to end.",
            "When implementation and required local validation are complete, update feature_list.json status to pending_review and record evidence.",
            "If you cannot complete it, set the feature status to blocked and append a blocked report with exact cause, evidence, and restart instructions.",
        ]
    else:
        status_contract = [
            f"Dispatcher selected feature {feature.id} ({feature.status}) - {feature.title}.",
            "Review the pending feature with a strict acceptance-gate stance.",
            "If the evidence and implementation are acceptable, update feature_list.json status to passing and record review evidence.",
            "If not acceptable, set the feature status to blocked and append a blocked report with exact cause, evidence, and restart instructions.",
        ]

    if requested_task:
        return f"{requested_task}\n\nDispatcher status contract:\n- " + "\n- ".join(status_contract)
    return "\n".join(status_contract)


def decide_dispatch(features: list[FeatureSummary], opts: CliOptions) -> DispatchDecision | None:
    if opts.feature:
        feature = feature_by_id(features, opts.feature)
        if not feature:
            raise ValueError(f"Requested feature not found: {opts.feature}")
        if feature.status == "blocked":
            print(f"[agent.py] dispatcher stopped: requested feature is blocked: {feature.id}", file=sys.stderr)
            print("[agent.py] Resolve the blocked report before dispatching new work.", file=sys.stderr)
            return None
        if feature.status == "passing":
            print(f"[agent.py] dispatcher stopped: requested feature is already passing: {feature.id}", file=sys.stderr)
            return None
        runner = "reviewer" if feature.status == "pending_review" else "coder"
        return DispatchDecision(
            feature=feature,
            runner=runner,
            reason=f"explicit feature {feature.id} status={feature.status}",
            task=dispatch_task_for(feature, runner, opts.task),
        )

    blocked = find_blocked_feature(features)
    if blocked:
        print(f"[agent.py] dispatcher stopped: blocked feature present: {blocked.id}", file=sys.stderr)
        print("[agent.py] Resolve the blocked report before dispatching new work.", file=sys.stderr)
        return None

    pending_review = sorted((f for f in features if f.status == "pending_review"), key=by_priority_then_id)
    if pending_review:
        feature = pending_review[0]
        return DispatchDecision(
            feature=feature,
            runner="reviewer",
            reason=f"auto-discovered pending_review feature {feature.id}",
            task=dispatch_task_for(feature, "reviewer", opts.task),
        )

    not_started = sorted((f for f in features if f.status == "not_started"), key=by_priority_then_id)
    if not_started:
        feature = not_started[0]
        return DispatchDecision(
            feature=feature,
            runner="coder",
            reason=f"auto-discovered not_started feature {feature.id}",
            task=dispatch_task_for(feature, "coder", opts.task),
        )

    in_progress = sorted((f for f in features if f.status == "in_progress"), key=by_priority_then_id)
    if in_progress:
        print(f"[agent.py] dispatcher stopped: only in_progress work remains ({in_progress[0].id}).", file=sys.stderr)
        print(
            "[agent.py] Pass --feature explicitly if you want dispatcher to continue that feature with the coder.",
            file=sys.stderr,
        )
        return None

    print("[agent.py] dispatcher stopped: no not_started or pending_review features found.", file=sys.stderr)
    return None


def resolve_layer2_docs(cwd: Path, feature: FeatureSummary | None, extra_refs: list[str]) -> list[str]:
    if not feature:
        return []

    if not feature.layer2_refs and not extra_refs:
        raise ValueError(
            f"Feature {feature.id} is missing layer2_refs. Add explicit Layer 2 docs in feature_list.json or pass --layer2-ref."
        )

    docs = list(dict.fromkeys([*feature.layer2_refs, *extra_refs]))
    for doc in docs:
        if not (cwd / doc).exists():
            raise ValueError(f"Layer 2 reference does not exist: {doc}")
    return docs


def format_feature_summaries(features: list[FeatureSummary]) -> str:
    return "\n".join(
        f"- {f.id} | {f.status} | P{f.priority} | {f.title} | layer2_refs={', '.join(f.layer2_refs) if f.layer2_refs else 'missing'}"
        for f in features
    )


def build_prompt(params: dict[str, Any]) -> str:
    init_result = params.get("init_result")
    if init_result is not None:
        init_block = f"exit={init_result.exit_code}\n{tail_lines(init_result.stdout + '\n' + init_result.stderr, 80)}"
    else:
        init_block = "Skipped by agent.ts --skip-init."

    selected_feature = params.get("selected_feature")
    selected = (
        f"{selected_feature.id} ({selected_feature.status}) - {selected_feature.title}" if selected_feature else "none"
    )

    layer2_block = "\n\n".join(
        f"### {doc['path']}\n{truncate(doc['text'], 0)}" for doc in params.get("layer2", [])
    )

    runner_config: RunnerConfig = params["runner_config"]
    if runner_config.runner == "coder":
        runner_contract = f"""You are the CODER runner.

- Implement the requested change end to end.
- Make scoped code/documentation edits where needed.
- Favor practical implementation exploration. Target temperature: {runner_config.temperature}.
- Run the smallest useful checks first, then the repository-required checks before finishing.
- Update progress/tracker files and commit when AGENTS.md requires it.
- If you finish implementation and validation, set the selected feature to pending_review, not passing.
- If you are blocked, set the selected feature to blocked and write a blocked report with cause, evidence, and restart instructions."""
    else:
        runner_contract = f"""You are the REVIEWER runner.

- Take a code-review and acceptance-gate stance.
- Be strict, deterministic, and evidence-driven. Target temperature: {runner_config.temperature}.
- Prioritize bugs, regressions, missing tests, unsafe state transitions, and evidence gaps.
- Do not make broad implementation changes. Only edit progress/tracker files if you are recording review evidence, blockers, or checklist results.
- If the work is acceptable, set the selected feature to passing with command evidence.
- If not acceptable, set the selected feature to blocked and write a blocked report with exact blockers."""

    layer2_paths = ", ".join(doc["path"] for doc in params.get("layer2", [])) or "none"
    git_log: CommandResult = params["git_log"]

    return f"""# Codex Runner Plan

- Generated at: {params['generated_at']}
- Runner: {runner_config.runner}
- Model: {runner_config.model or 'default'}
- Effort: {runner_config.effort or 'default'}
- Target temperature: {runner_config.temperature}
- Repository: {params['cwd']}
- Selected feature: {selected}
- User task: {params['task']}
- Routed docs: {layer2_paths}

---

You are Codex running inside {params['cwd']}.

The user task is:
{params['task']}

This prompt was generated by agent.py. It has already split the repository AGENTS.md protocol into bounded context sections. Follow the repository rules exactly and continue from the evidence below rather than restarting from scratch.

## Runner Contract

{runner_contract}

## Required Operating Contract

- Work in repo root: {params['cwd']}
- Respect AGENTS.md and CONTEXT-GATE.md.
- Keep exactly one active feature. The selected feature for this run is: {selected}
- If the selected feature is not the correct one, update feature tracking explicitly before changing production code.
- Do not hide incomplete work by weakening tests or marking features passing without evidence.
- Before finishing, update claude-progress.md and feature_list.json when required by AGENTS.md.
- Before finishing, read evaluator-rubric.md and clean-state-checklist.md and record the required PASS/FAIL evidence.
- If pnpm build passes, commit the completed work.

## Layer 0: AGENTS.md

{truncate(params['agents'], 9000)}

## Layer 0: CONTEXT-GATE.md

{truncate(params['context_gate'], 9000)}

## Preflight Evidence

### pwd
{params['cwd']}

### git log --oneline -5
exit={git_log.exit_code}
{git_log.stdout.strip()}
{git_log.stderr.strip()}

### ./init.sh
{init_block}

## Layer 1: claude-progress.md summary

{params['progress_summary']}

## Layer 1: feature_list.json summaries

{format_feature_summaries(params['features'])}

## Layer 2: routed docs

{layer2_block}

## Execution Request

Perform the user task now. Be autonomous: inspect only the files needed, implement changes, verify, update progress/tracker, and commit when appropriate."""


def build_provider_instruction(cwd: Path, plan_path: Path) -> str:
    relative_path = str(plan_path.relative_to(cwd))
    return (
        f"Read {relative_path} and execute the plan exactly. "
        "Use that file as the full prompt/context; do not ask me to paste it again."
    )


def runner_defaults(opts: CliOptions, runner: str) -> RunnerConfig:
    if runner == "coder":
        return RunnerConfig(
            runner="coder",
            model=opts.model or opts.coder_model or DEFAULT_CODER_MODEL,
            effort=opts.effort or opts.coder_effort or DEFAULT_CODER_EFFORT,
            temperature=opts.temperature or opts.coder_temperature or DEFAULT_CODER_TEMPERATURE,
        )
    return RunnerConfig(
        runner="reviewer",
        model=opts.model or opts.reviewer_model or DEFAULT_REVIEWER_MODEL,
        effort=opts.effort or opts.reviewer_effort or DEFAULT_REVIEWER_EFFORT,
        temperature=opts.temperature or opts.reviewer_temperature or DEFAULT_REVIEWER_TEMPERATURE,
    )


def with_runner_config(opts: CliOptions, config: RunnerConfig) -> CliOptions:
    return replace(opts, runner=config.runner, model=config.model, effort=config.effort)


def make_runner_task(task: str, runner: str) -> str:
    if runner == "coder":
        return task
    return f"Review and acceptance-check the coder work for this task: {task}"


async def spawn_codex(command: str, args: list[str], cwd: Path) -> int:
    try:
        proc = await asyncio.create_subprocess_exec(command, *args, cwd=str(cwd))
        return await proc.wait()
    except FileNotFoundError as exc:
        print(f"[agent.py] failed to start {command}: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - convert unexpected spawn errors to a stable non-zero exit code
        print(f"[agent.py] failed to start {command}: {exc}", file=sys.stderr)
        return 1


def load_run_context(opts: CliOptions, cwd: Path, selected_feature_override: FeatureSummary | None = None) -> dict[str, Any]:
    agents = read_text(cwd / "AGENTS.md")
    context_gate = read_text(cwd / "CONTEXT-GATE.md")
    git_log = run("git", ["log", "--oneline", "-5"], cwd)

    init_result = None
    if not opts.skip_init:
        init_result = run("./init.sh", [], cwd, timeout_ms=180_000)
        if init_result.exit_code != 0:
            print(
                "[agent.py] ./init.sh failed. The generated prompt will include the failure, "
                "but Codex will not be launched automatically.",
                file=sys.stderr,
            )
            print(tail_lines(init_result.stdout + "\n" + init_result.stderr, 80), file=sys.stderr)
            raise RuntimeError("init.sh failed")

    progress_summary = extract_current_status_and_latest_session(read_text(cwd / "claude-progress.md"))
    features = parse_feature_summaries(read_text(cwd / "feature_list.json"))
    selected_feature = selected_feature_override or select_feature(features, opts.feature)
    layer2_paths = resolve_layer2_docs(cwd, selected_feature, opts.layer2_refs)
    layer2 = [{"path": path, "text": read_text(cwd / path)} for path in layer2_paths]

    return {
        "agents": agents,
        "context_gate": context_gate,
        "git_log": git_log,
        "init_result": init_result,
        "progress_summary": progress_summary,
        "features": features,
        "selected_feature": selected_feature,
        "layer2": layer2,
    }


async def run_harness(
    opts: CliOptions,
    cwd: Path,
    runner_config: RunnerConfig,
    selected_feature_override: FeatureSummary | None = None,
    task_override: str | None = None,
) -> int:
    context = load_run_context(opts, cwd, selected_feature_override)
    base_task = task_override or opts.task
    if not base_task:
        raise ValueError(f"Missing task for {runner_config.runner} runner.")
    runner_task = make_runner_task(base_task, runner_config.runner)

    prompt = build_prompt(
        {
            "cwd": str(cwd),
            "task": runner_task,
            "runner_config": runner_config,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "agents": context["agents"],
            "context_gate": context["context_gate"],
            "git_log": context["git_log"],
            "init_result": context["init_result"],
            "progress_summary": context["progress_summary"],
            "features": context["features"],
            "selected_feature": context["selected_feature"],
            "layer2": context["layer2"],
        }
    )

    runner_opts = with_runner_config(opts, runner_config)
    plan_path = write_plan_file(cwd, opts.plan_dir, prompt, runner_config.runner)
    provider_instruction = build_provider_instruction(cwd, plan_path)
    provider_command = build_provider_command(
        provider=runner_opts.agent_provider,
        agent_bin=runner_opts.agent_bin,
        permission_mode=runner_opts.permission_mode,
        default_permission_mode=DEFAULT_PERMISSION_MODE,
        model=runner_opts.model,
        output_format=runner_opts.output_format,
        dangerously_skip_permissions=runner_opts.dangerously_skip_permissions,
        continue_session=runner_opts.continue_session,
        resume=runner_opts.resume,
        cwd=cwd,
        instruction=provider_instruction,
        extra_agent_args=runner_opts.extra_agent_args,
    )

    if opts.dry_run:
        selected_feature = context["selected_feature"]
        print(f"[agent.py] cwd={cwd}")
        print(
            f"[agent.py] runner={runner_config.runner} "
            f"model={runner_config.model or '-'} effort={runner_config.effort or '-'} "
            f"temperature={runner_config.temperature}"
        )
        print(f"[agent.py] agentProvider={runner_opts.agent_provider} agentBin={runner_opts.agent_bin}")
        print(
            f"[agent.py] selectedFeature={selected_feature.id if selected_feature else 'none'} "
            f"status={selected_feature.status if selected_feature else '-'}"
        )
        print(f"[agent.py] layer2={', '.join(doc['path'] for doc in context['layer2'])}")
        print(f"[agent.py] plan={plan_path.relative_to(cwd)}")
        encoded = " ".join(json.dumps(arg) for arg in provider_command.args)
        print(f"[agent.py] command={Path(provider_command.command).name} {encoded}")
        print("\nPrompt written to the plan file above. Re-run without --dry-run to launch the selected provider.")
        return 0

    selected_feature = context["selected_feature"]
    print(f"[agent.py] wrote plan {plan_path.relative_to(cwd)}")
    print(
        f"[agent.py] launching {Path(provider_command.command).name} "
        f"provider={runner_opts.agent_provider} "
        f"runner={runner_config.runner} feature={selected_feature.id if selected_feature else 'none'} "
        f"with {len(context['layer2'])} routed docs"
    )
    return await spawn_codex(provider_command.command, provider_command.args, cwd)


async def run_dispatcher_once(opts: CliOptions, cwd: Path, iteration: int | None = None) -> DispatcherRunResult:
    features = read_feature_summaries(cwd)
    blocked = find_blocked_feature(features, opts.feature)
    if blocked:
        print(f"[agent.py] dispatcher stopped: blocked feature present: {blocked.id}", file=sys.stderr)
        print("[agent.py] Resolve the blocked report before dispatching new work.", file=sys.stderr)
        return DispatcherRunResult(exit_code=1, stop_reason="blocked")

    decision = decide_dispatch(features, opts)
    if not decision:
        return DispatcherRunResult(exit_code=1, stop_reason="no_work")

    prefix = "dispatcher decision" if iteration is None else f"dispatcher loop iteration={iteration}"
    print(f"[agent.py] {prefix}: {decision.reason} -> {decision.runner}")
    dispatch_opts = replace(opts, feature=decision.feature.id)
    exit_code = await run_harness(
        dispatch_opts,
        cwd,
        runner_defaults(dispatch_opts, decision.runner),
        selected_feature_override=decision.feature,
        task_override=decision.task,
    )
    return DispatcherRunResult(
        decision=decision,
        exit_code=exit_code,
        previous_status=decision.feature.status,
    )


async def run_dispatcher_loop(opts: CliOptions, cwd: Path) -> int:
    max_iterations = parse_non_negative_int(opts.max_loop_iterations, "--max-loop-iterations")
    delay_ms = parse_non_negative_int(opts.loop_delay_ms, "--loop-delay-ms")
    iteration = 0

    while True:
        if max_iterations > 0 and iteration >= max_iterations:
            print(f"[agent.py] dispatcher loop stopped: reached --max-loop-iterations={max_iterations}")
            return 0

        iteration += 1
        result = await run_dispatcher_once(opts, cwd, iteration)
        if result.stop_reason == "blocked":
            return 1
        if result.stop_reason == "no_work":
            print("[agent.py] dispatcher loop stopped: no dispatchable feature remains.")
            return 0
        if result.exit_code != 0:
            return result.exit_code
        if opts.dry_run:
            print("[agent.py] dispatcher loop dry-run stops after one planned iteration to avoid repeating unchanged state.")
            return 0

        if not result.decision:
            return 1

        updated_feature = feature_by_id(read_feature_summaries(cwd), result.decision.feature.id)
        if not updated_feature:
            print(
                f"[agent.py] dispatcher loop stopped: feature disappeared after run: {result.decision.feature.id}",
                file=sys.stderr,
            )
            return 1
        if updated_feature.status == "blocked":
            print(f"[agent.py] dispatcher loop stopped: feature became blocked: {updated_feature.id}", file=sys.stderr)
            return 1
        if updated_feature.status == result.previous_status:
            print(
                "[agent.py] dispatcher loop stopped: feature status did not change after successful run: "
                f"{updated_feature.id} status={updated_feature.status}",
                file=sys.stderr,
            )
            print("[agent.py] This guard prevents repeatedly dispatching the same unfinished state.", file=sys.stderr)
            return 1

        print(
            f"[agent.py] dispatcher loop transition: {updated_feature.id} "
            f"{result.previous_status} -> {updated_feature.status}"
        )
        if delay_ms > 0:
            await asyncio.sleep(delay_ms / 1000)


def ensure_root_files(cwd: Path) -> None:
    for required in REQUIRED_ROOT_FILES:
        if not (cwd / required).exists():
            raise ValueError(f"Missing {required}; run from repository root.")


async def run_with_options(opts: CliOptions) -> int:
    cwd = Path.cwd()
    ensure_root_files(cwd)

    if opts.runner == "dispatcher":
        if opts.loop:
            return await run_dispatcher_loop(opts, cwd)
        return (await run_dispatcher_once(opts, cwd)).exit_code

    runner_cfg = runner_defaults(opts, opts.runner)
    return await run_harness(opts, cwd, runner_cfg)


def parse_options(raw_argv: list[str]) -> CliOptions:
    parsed_cli_args, extra_agent_args = split_forwarded_args(raw_argv)
    parser = build_parser()
    parsed = parser.parse_args(parsed_cli_args)
    return to_cli_options(parsed, parsed_cli_args, extra_agent_args)


async def async_main(raw_argv: list[str] | None = None) -> int:
    argv = raw_argv if raw_argv is not None else sys.argv[1:]
    opts = parse_options(argv)
    return await run_with_options(opts)


def main(raw_argv: list[str] | None = None) -> int:
    try:
        return asyncio.run(async_main(raw_argv))
    except Exception as error:  # noqa: BLE001 - top-level CLI should fail closed with exit code 1
        print(str(error), file=sys.stderr)
        return 1
