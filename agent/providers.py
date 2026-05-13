from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

AgentProviderId = Literal["codex", "claude", "openharness", "kimi", "gemini"]

AGENT_PROVIDER_IDS: tuple[AgentProviderId, ...] = ("codex", "claude", "openharness", "kimi", "gemini")


@dataclass(frozen=True)
class AgentProvider:
    id: AgentProviderId
    display_name: str
    default_bin: str
    status: Literal["supported", "registered_unsupported"]


@dataclass(frozen=True)
class ProviderCommand:
    command: str
    args: list[str]


AGENT_PROVIDERS: dict[AgentProviderId, AgentProvider] = {
    "codex": AgentProvider("codex", "Codex", "codex", "supported"),
    "claude": AgentProvider("claude", "Claude", "claude", "registered_unsupported"),
    "openharness": AgentProvider("openharness", "OpenHarness", "openharness", "registered_unsupported"),
    "kimi": AgentProvider("kimi", "Kimi", "kimi", "registered_unsupported"),
    "gemini": AgentProvider("gemini", "Gemini", "gemini", "registered_unsupported"),
}


def resolve_agent_provider(value: str) -> AgentProviderId:
    if value in AGENT_PROVIDER_IDS:
        return value  # type: ignore[return-value]
    supported = ", ".join(AGENT_PROVIDER_IDS)
    raise ValueError(f"Unsupported agent provider: {value}. Supported providers: {supported}")


def build_codex_provider_command(
    *,
    agent_bin: str,
    permission_mode: str,
    default_permission_mode: str,
    model: str | None,
    output_format: str | None,
    dangerously_skip_permissions: bool,
    continue_session: bool,
    resume: str | None,
    cwd: Path,
    instruction: str,
    extra_agent_args: list[str],
) -> ProviderCommand:
    args: list[str] = ["exec"]

    if continue_session or resume:
        args.append("resume")
        if continue_session and not resume:
            args.append("--last")
        if resume:
            args.append(resume)
    else:
        args.extend(["--cd", str(cwd)])
        if permission_mode == default_permission_mode:
            args.extend(["--sandbox", "danger-full-access"])
            args = ["--ask-for-approval", "never", *args]

    if model:
        args.extend(["--model", model])
    if output_format == "json":
        args.append("--json")
    elif output_format:
        raise ValueError(
            f"Unsupported Codex output format: {output_format}. "
            "Use --output-format json or pass raw provider args after --."
        )
    if dangerously_skip_permissions:
        args.append("--dangerously-bypass-approvals-and-sandbox")

    args.extend(extra_agent_args)
    args.append(instruction)
    return ProviderCommand(command=agent_bin, args=args)


def build_provider_command(
    *,
    provider: AgentProviderId,
    agent_bin: str,
    permission_mode: str,
    default_permission_mode: str,
    model: str | None,
    output_format: str | None,
    dangerously_skip_permissions: bool,
    continue_session: bool,
    resume: str | None,
    cwd: Path,
    instruction: str,
    extra_agent_args: list[str],
) -> ProviderCommand:
    if provider == "codex":
        return build_codex_provider_command(
            agent_bin=agent_bin,
            permission_mode=permission_mode,
            default_permission_mode=default_permission_mode,
            model=model,
            output_format=output_format,
            dangerously_skip_permissions=dangerously_skip_permissions,
            continue_session=continue_session,
            resume=resume,
            cwd=cwd,
            instruction=instruction,
            extra_agent_args=extra_agent_args,
        )

    provider_info = AGENT_PROVIDERS[provider]
    raise ValueError(
        f"Agent provider {provider_info.id} ({provider_info.display_name}) is registered but not executable yet. "
        "Use --agent-provider codex for the current supported execution path."
    )
