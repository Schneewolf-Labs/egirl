# Tools

Zero's toolchain. This doubles as the **RE-toolbox manifest** — the tools a reverse-engineering persona depends on, and how to install them. Beyond egirl's built-in tools (files, shell, memory, git, tasks, `report`), an RE grind leans almost entirely on `execute_command` driving the native toolchain below.

Install the whole toolbox with:

```bash
scripts/setup-tools.sh re-toolbox
```

(That runs inside the sandbox. See [scripts/setup-tools.sh](../../../scripts/setup-tools.sh) and, for the VM the toolbox lives in, [services/vm/README.md](../../../services/vm/README.md).)

## The RE Toolchain

| Tool | What it's for | Install |
|------|---------------|---------|
| **wine + 32-bit (`wine32:i386`)** | Run the Win32 target binary and native oracles to capture ground-truth output | `re-toolbox` |
| **radare2 (`r2`)** | Disassembly, static analysis, native tracing; built from source (apt often has no candidate) | `re-toolbox` |
| **Ghidra 12 (headless) + Java 21** | Decompilation and cross-references; run via `<ghidra>/support/analyzeHeadless`. Ghidra itself is a separate ~570MB download (link in the installer); Java 21 is required and installed by the bundle | Java via `re-toolbox`; Ghidra manual |
| **objdump / binutils / xxd** | Quick disassembly, symbol/section dumps, hex inspection | `base` |
| **python RE venv (`~/re-venv`)** | `pefile` (PE headers/sections), `capstone` (disassembly), `construct` (declarative binary parsing) for building parsers and analysis scripts | `re-toolbox` |
| **gcc / build-essential** | Compile native harnesses, oracles, and the portable reimplementation | `base` |
| **file / jq** | Identify unknown blobs; script over JSON output | `base` |

## How Zero Uses Them

- **Ground-truth capture**: run the original under `wine`, capture exact output → the oracle her reimplementation must match byte-for-byte.
- **Static understanding**: Ghidra headless + r2 + objdump to read control flow and confirm semantics — never trust a lone decompiler guess.
- **Parsing**: the `~/re-venv` (pefile/capstone/construct) to script structure extraction and reproduce it in portable code.
- **Verification harness**: gcc-built native harnesses that diff her output against the oracle across a widening input set.

## egirl Built-in Tools

The standard set is still available and used constantly:

- `execute_command` — the workhorse; drives the entire native toolchain above
- `read_file`, `write_file`, `edit_file`, `glob_files` — NOTES.md, `work/` artifacts, harness source
- `memory_*` — durable facts across runs (complements NOTES.md)
- `git_*` — version the reimplementation as it comes together
- `report` — `ask` / `notify` a supervisor when blocked or when a goal is exhausted (see [docs/autonomy-loop.md](../../../docs/autonomy-loop.md))
- `task_*` — schedule and manage the long-running grind

Note: Zero typically runs **without** `code_agent` — a capable local operator does the RE work directly, and a delegation hop would only cost the context continuity the autonomy loop depends on.
