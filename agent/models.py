from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

RunnerMode = Literal["coder", "reviewer", "dispatcher"]
RunnerExecMode = Literal["coder", "reviewer"]
StopReason = Literal["blocked", "no_work"]


@dataclass(frozen=True)
class FeatureSummary:
    id: str
    title: str
    status: str
    priority: int
    layer2_refs: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DispatchDecision:
    feature: FeatureSummary
    reason: str
    runner: RunnerExecMode
    task: str


@dataclass(frozen=True)
class CommandResult:
    command: str
    exit_code: int | None
    stdout: str
    stderr: str


@dataclass(frozen=True)
class DispatcherRunResult:
    exit_code: int
    decision: DispatchDecision | None = None
    previous_status: str | None = None
    stop_reason: StopReason | None = None


@dataclass(frozen=True)
class CliOptions:
    task: str | None
    feature: str | None
    runner: RunnerMode
    model: str | None
    effort: str | None
    temperature: str | None
    coder_model: str | None
    coder_effort: str | None
    coder_temperature: str | None
    reviewer_model: str | None
    reviewer_effort: str | None
    reviewer_temperature: str | None
    max_turns: str
    permission_mode: str
    name: str | None
    codex_bin: str
    plan_dir: str
    layer2_refs: list[str]
    dry_run: bool
    loop: bool
    loop_delay_ms: str
    max_loop_iterations: str
    skip_init: bool
    continue_session: bool
    resume: str | None
    output_format: str | None
    dangerously_skip_permissions: bool
    extra_codex_args: list[str]


@dataclass(frozen=True)
class RunnerConfig:
    runner: RunnerExecMode
    model: str | None
    effort: str | None
    temperature: str
