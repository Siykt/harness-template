DEFAULT_MAX_TURNS = "40"
DEFAULT_PERMISSION_MODE = "full_auto"
DEFAULT_CODEX_BIN = "codex"
DEFAULT_LOOP_DELAY_MS = "1000"
DEFAULT_MAX_LOOP_ITERATIONS = "0"
DEFAULT_CODER_MODEL = "gpt-5.5"
DEFAULT_CODER_EFFORT = "high"
DEFAULT_CODER_TEMPERATURE = "0.3"
DEFAULT_REVIEWER_MODEL = "gpt-5.5"
DEFAULT_REVIEWER_EFFORT = "high"
DEFAULT_REVIEWER_TEMPERATURE = "0"

KNOWN_CLI_FLAGS = {
    "--task",
    "-t",
    "--feature",
    "-f",
    "--runner",
    "--model",
    "-m",
    "--effort",
    "--temperature",
    "--coder-model",
    "--coder-effort",
    "--coder-temperature",
    "--reviewer-model",
    "--reviewer-effort",
    "--reviewer-temperature",
    "--max-turns",
    "--permission-mode",
    "--name",
    "-n",
    "--codex-bin",
    "--oh-bin",
    "--plan-dir",
    "--layer2-ref",
    "--dry-run",
    "--dryRun",
    "--loop",
    "--loop-delay-ms",
    "--max-loop-iterations",
    "--skip-init",
    "--skipInit",
    "--continue",
    "-c",
    "--resume",
    "-r",
    "--output-format",
    "--dangerously-skip-permissions",
    "--dangerouslySkipPermissions",
}

REQUIRED_ROOT_FILES = (
    "AGENTS.md",
    "CONTEXT-GATE.md",
    "claude-progress.md",
    "feature_list.json",
)
