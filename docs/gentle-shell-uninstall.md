# Removing Gentle Shell

`gentle-shell self-uninstall` removes what Gentle Shell created and then the
`gentle-pi` package. It always prints the full plan first, and nothing is removed
until you confirm.

```bash
gentle-shell self-uninstall --dry-run          # only print the plan
gentle-shell self-uninstall                    # print the plan, then ask
gentle-shell self-uninstall --yes              # remove without asking; keeps shared configuration
gentle-shell self-uninstall --yes --include-shared
```

`gentle-shell uninstall <source>` is a different command: it is Pi's own alias
for `remove`, forwarded to the resolved home, and stays unchanged.

## What it removes

In this order:

1. **Gentle Shell's own data**, each only when it is a real directory or file
   (never a symbolic link):
   - `<config home>/main/`: main-channel builds.
   - `<config home>/channel.json`: the recorded update channel.
   - `<config home>/dev-binary.json`, only when it points at a main-channel build
     under `<config home>/main/gentle-ai`. A dev binary you registered yourself
     is kept.
   - `<config home>/tools/go`: the Go the installer downloaded for builds.
   - The isolated home: `GENTLE_SHELL_HOME`, or `~/.gentle-shell/agent`. It holds
     the sign-ins, chats and settings of Gentle Shell sessions. A
     `GENTLE_SHELL_HOME` directory is removed only when Gentle Shell created it
     (its `.gentle-shell-home` marker, or its setup record in
     `~/.gentle-shell/config.json`); otherwise it is listed as kept.
   - `~/.gentle-shell/config.json`: the launcher settings.
2. **Shared Gentle AI configuration**, only when you accept it (see below).
3. **The `gentle-pi` package**, with the package manager that owns it:
   `pnpm remove -g gentle-pi` under `PNPM_HOME`, otherwise
   `npm uninstall -g gentle-pi`.
4. **`~/.gentle-shell`**, only when it is empty.

The config home is `GENTLE_PI_CONFIG_HOME`, or `~/.pi/gentle-ai`.

## Shared configuration

Pi with Gentle AI uses the same files in the config home, so they are kept by
default: `profiles.json`, `profiles.export.json`, `banner.json`,
`builtin-codemode-optout.json`, `background-subagents.json`,
`double-esc-cancel.json`, `runtime-guardrails.json` and `persona.json`.

- In a terminal, after you confirm the plan, a separate question asks whether
  to remove them; the default is No.
- With `--yes`, they are kept unless you also pass `--include-shared`.
- `--include-shared` removes them without the separate question.

Only those exact files are removed; anything else in the config home stays.

## What it never touches

- Your Pi home (`~/.pi/agent`, `PI_CODING_AGENT_DIR` or
  `GENTLE_SHELL_USER_PI_HOME`) and its `settings.json`.
- Custom homes used with `--home <path>`, recorded in
  `~/.gentle-shell/config.json`; the plan lists them as not touched.
- Gentle AI's own state in `~/.gentle-ai`, and each project's `.pi/gentle-ai`
  folder.
- Tools the web installer may have added. The plan lists them with how to remove
  them yourself: Pi (`pnpm remove -g @earendil-works/pi-coding-agent` or
  `npm uninstall -g @earendil-works/pi-coding-agent`), Engram (installed by Gentle
  AI's setup), the PATH entry `pnpm setup` added and, on Windows,
  `%USERPROFILE%\.pnpm`.

## Refusals and exit codes

It refuses, before removing anything, when:

- the isolated home is, or contains, your home directory, Pi's default home,
  your Pi home or the config home;
- `GENTLE_SHELL_HOME` or `GENTLE_PI_CONFIG_HOME` is not an absolute path;
- neither pnpm nor npm owns the installation (an `npm link` of a source checkout,
  for example), or the owning package manager is not on `PATH`. Remove that
  installation the way you made it.

| Exit code | Meaning |
| --- | --- |
| 0 | Removed, or `--dry-run` printed the plan. |
| 1 | Refused, cancelled, or a removal failed. A refusal exits 1 even with `--dry-run`, since the real run would refuse too. |
| 2 | Usage error, including no terminal to confirm in without `--yes`. |

When a removal fails, it stops there: the `gentle-pi` package and everything
after it are kept, so `gentle-shell self-uninstall` is still there to run again.
When only the package removal fails, it prints the command to run yourself.

It runs before any Pi runtime check, so it also works when Pi is missing.

## Windows

Removing the running `gentle-pi` package with pnpm or npm on Windows has not been
verified yet. If the package manager fails, Gentle Shell's data is already gone
and the command prints the exact `pnpm remove -g gentle-pi` or
`npm uninstall -g gentle-pi` to run from a new terminal.
