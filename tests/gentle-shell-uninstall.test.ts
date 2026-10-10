import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runSelfUninstall, SHARED_CONFIG_FILES } from "../lib/gentle-shell-uninstall.ts";

const posixOnly = { skip: process.platform === "win32" };
const SHA = "1f9d5e6423e37f7d2316859045f379ba9b5d8c3a";

type Owner = { name: "pnpm" | "npm"; command: string };
type Options = {
	owner?: Owner | Error;
	env?: Record<string, string>;
	interactive?: boolean;
	answers?: string[];
	platform?: string;
	runCode?: number;
};

function write(path: string, text = "{}\n") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

/** A sandboxed $HOME holding a full Gentle Shell installation; the real home is never touched. */
function world() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "self-uninstall-")));
	const home = join(root, "home");
	const config = join(home, ".pi", "gentle-ai");
	const shell = join(home, ".gentle-shell");
	const isolated = join(shell, "agent");
	const piHome = join(home, ".pi", "agent");
	const paths = {
		main: join(config, "main"),
		channel: join(config, "channel.json"),
		devBinary: join(config, "dev-binary.json"),
		go: join(config, "tools", "go"),
		isolated,
		launcherConfig: join(shell, "config.json"),
	};
	write(join(paths.main, "gentle-ai", SHA, "gentle-ai"), "binary");
	write(paths.channel, JSON.stringify({ schema: "gentle-shell.channel/v1", channel: "main", shellCommit: SHA, gentleAiCommit: SHA }));
	write(paths.devBinary, JSON.stringify({ schema: "gentle-pi.dev-binary/v1", path: join(paths.main, "gentle-ai", SHA, "gentle-ai") }));
	write(join(paths.go, "1.25.10", "go", "bin", "go"), "go");
	write(join(isolated, "settings.json"));
	write(join(isolated, ".gentle-shell-home"));
	write(paths.launcherConfig, JSON.stringify({ home: "isolated" }));
	for (const name of ["profiles.json", "persona.json"]) write(join(config, name));
	write(join(config, "unknown.json"));
	write(join(piHome, "settings.json"));
	const calls: { command: string; argv: string[]; ownDataLeft: string[]; sharedLeft: boolean; shellLeft: boolean }[] = [];
	const out: string[] = [];
	const err: string[] = [];
	const questions: string[] = [];
	const ownLeft = () => Object.values(paths).filter((path) => existsSync(path));
	const uninstall = (args: string[], options: Options = {}) => {
		const answers = [...(options.answers ?? [])];
		return runSelfUninstall({
			args,
			env: options.env ?? {},
			homedir: home,
			platform: options.platform ?? "darwin",
			interactive: options.interactive ?? false,
			resolveOwner: async () => {
				const owner = options.owner ?? { name: "pnpm", command: "/usr/bin/pnpm" };
				if (owner instanceof Error) throw owner;
				return owner;
			},
			run: async (command: string, argv: string[]) => {
				calls.push({ command, argv, ownDataLeft: ownLeft(), sharedLeft: existsSync(join(config, "profiles.json")), shellLeft: existsSync(shell) });
				return { code: options.runCode ?? 0 };
			},
			ask: async (question: string) => {
				questions.push(question);
				return answers.shift() ?? "";
			},
			out: (line: string) => out.push(line),
			err: (line: string) => err.push(line),
		});
	};
	return { root, home, config, shell, isolated, piHome, paths, calls, out, err, questions, ownLeft, uninstall, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type World = ReturnType<typeof world>;

function untouched(w: World) {
	assert.deepEqual(w.ownLeft().sort(), Object.values(w.paths).sort());
	assert.equal(existsSync(join(w.config, "profiles.json")), true);
	assert.deepEqual(w.calls, []);
}

test("unknown self-uninstall arguments are a usage error that removes nothing", async () => {
	for (const args of [["--force"], ["now"], ["--yes=1"]]) {
		const w = world();
		try {
			assert.equal(await w.uninstall(args), 2);
			assert.match(w.err.join("\n"), /usage: gentle-shell self-uninstall \[--dry-run\] \[--yes\] \[--include-shared\]/);
			untouched(w);
		} finally { w.cleanup(); }
	}
});

test("--dry-run prints the whole plan and removes nothing", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall(["--dry-run"]), 0);
		const plan = w.out.join("\n");
		for (const path of Object.values(w.paths)) assert.ok(plan.includes(path), path);
		assert.ok(plan.includes("pnpm remove -g gentle-pi"));
		assert.ok(plan.includes(join(w.config, "profiles.json")));
		assert.ok(plan.includes(w.piHome));
		assert.match(plan, /Dry run: nothing was removed\./);
		untouched(w);
		assert.deepEqual(w.questions, []);
	} finally { w.cleanup(); }
});

test("without a terminal and without --yes it prints the plan and exits 2", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall([]), 2);
		assert.ok(w.out.join("\n").includes(w.paths.isolated));
		assert.match(w.err.join("\n"), /--yes/);
		untouched(w);
	} finally { w.cleanup(); }
});

test("--yes removes Gentle Shell's own data, then the package, then the empty ~/.gentle-shell, keeping shared configuration", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall(["--yes"]), 0);
		assert.deepEqual(w.calls.map(({ command, argv }) => `${command} ${argv.join(" ")}`), ["/usr/bin/pnpm remove -g gentle-pi"]);
		assert.deepEqual(w.calls[0].ownDataLeft, [], "own data is removed before the package");
		assert.equal(w.calls[0].shellLeft, true, "~/.gentle-shell is removed only after the package");
		assert.equal(existsSync(w.shell), false);
		assert.deepEqual(w.ownLeft(), []);
		assert.equal(existsSync(join(w.config, "tools")), false);
		for (const name of ["profiles.json", "persona.json", "unknown.json"]) assert.equal(existsSync(join(w.config, name)), true, name);
		assert.equal(existsSync(join(w.piHome, "settings.json")), true);
		assert.deepEqual(w.questions, []);
		assert.match(w.out.join("\n"), /Gentle Shell was removed\./);
	} finally { w.cleanup(); }
});

test("an npm-owned installation is removed with npm uninstall -g", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall(["--yes"], { owner: { name: "npm", command: "/usr/bin/npm" } }), 0);
		assert.deepEqual(w.calls.map(({ command, argv }) => `${command} ${argv.join(" ")}`), ["/usr/bin/npm uninstall -g gentle-pi"]);
	} finally { w.cleanup(); }
});

test("--yes --include-shared also removes exactly the shared Gentle AI configuration files", async () => {
	const w = world();
	try {
		for (const name of SHARED_CONFIG_FILES) write(join(w.config, name));
		assert.equal(await w.uninstall(["--yes", "--include-shared"]), 0);
		for (const name of SHARED_CONFIG_FILES) assert.equal(existsSync(join(w.config, name)), false, name);
		assert.equal(w.calls[0].sharedLeft, false, "shared configuration is removed before the package");
		assert.equal(existsSync(join(w.config, "unknown.json")), true);
		assert.equal(existsSync(join(w.piHome, "settings.json")), true);
	} finally { w.cleanup(); }
});

test("the shared files are the Gentle AI configuration Gentle Shell writes", () => {
	assert.deepEqual([...SHARED_CONFIG_FILES].sort(), [
		"background-subagents.json", "banner.json", "builtin-codemode-optout.json", "double-esc-cancel.json",
		"persona.json", "profiles.export.json", "profiles.json", "runtime-guardrails.json",
	]);
});

test("a dev binary the user registered is kept", async () => {
	const w = world();
	try {
		write(w.paths.devBinary, JSON.stringify({ schema: "gentle-pi.dev-binary/v1", path: "/Users/me/src/gentle-ai/gentle-ai" }));
		assert.equal(await w.uninstall(["--yes"]), 0);
		assert.equal(existsSync(w.paths.devBinary), true);
		assert.match(w.out.join("\n"), /dev-binary\.json: points at a binary you registered yourself/);
	} finally { w.cleanup(); }
});

test("in a terminal the default answer cancels and removes nothing", async () => {
	for (const answer of ["", "n", "no", "maybe"]) {
		const w = world();
		try {
			assert.equal(await w.uninstall([], { interactive: true, answers: [answer] }), 1);
			assert.equal(w.questions.length, 1);
			assert.match(w.out.join("\n"), /Cancelled; nothing was removed\./);
			untouched(w);
		} finally { w.cleanup(); }
	}
});

test("in a terminal the shared configuration is asked about separately and kept by default", async () => {
	for (const [answer, removed] of [["", false], ["n", false], ["y", true], ["YES", true]] as const) {
		const w = world();
		try {
			assert.equal(await w.uninstall([], { interactive: true, answers: ["y", answer] }), 0);
			assert.equal(w.questions.length, 2);
			assert.match(w.questions[1], /shared Gentle AI configuration/);
			assert.match(w.questions[1], /\[y\/N\]/);
			assert.equal(existsSync(join(w.config, "profiles.json")), !removed, answer);
			assert.deepEqual(w.ownLeft(), []);
		} finally { w.cleanup(); }
	}
});

test("in a terminal --include-shared skips the separate question", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall(["--include-shared"], { interactive: true, answers: ["y"] }), 0);
		assert.equal(w.questions.length, 1);
		assert.equal(existsSync(join(w.config, "profiles.json")), false);
	} finally { w.cleanup(); }
});

test("an installation no package manager owns, such as npm link, is refused before anything is removed", async () => {
	const w = world();
	try {
		const owner = new Error("uninstall-owner-unknown: neither pnpm nor npm owns /src/gentle-pi");
		for (const args of [["--yes"], ["--dry-run"]]) {
			assert.equal(await w.uninstall(args, { owner }), 1);
			assert.match(w.err.join("\n"), /neither pnpm nor npm owns \/src\/gentle-pi/);
			untouched(w);
		}
	} finally { w.cleanup(); }
});

test("an isolated home that is or contains the user's Pi home, $HOME or the config home is refused", async () => {
	const cases = (w: World) => [
		{ GENTLE_SHELL_HOME: w.piHome },
		{ GENTLE_SHELL_HOME: join(w.home, ".pi") },
		{ GENTLE_SHELL_HOME: w.home },
		{ GENTLE_SHELL_HOME: w.root },
		{ GENTLE_SHELL_HOME: w.config },
		{ GENTLE_SHELL_HOME: join(w.root, "agent"), PI_CODING_AGENT_DIR: join(w.root, "agent", "pi") },
		{ GENTLE_SHELL_HOME: join(w.root, "agent"), GENTLE_SHELL_USER_PI_HOME: join(w.root, "agent") },
	];
	for (let index = 0; index < 7; index += 1) {
		const w = world();
		try {
			const env = cases(w)[index];
			writeFileSync(join(w.home, "keep.txt"), "x");
			assert.equal(await w.uninstall(["--yes"], { env }), 1, JSON.stringify(env));
			assert.match(w.err.join("\n"), /refusing to remove anything/);
			untouched(w);
			assert.equal(existsSync(join(w.home, "keep.txt")), true);
		} finally { w.cleanup(); }
	}
});

test("a relative GENTLE_SHELL_HOME or GENTLE_PI_CONFIG_HOME is refused", async () => {
	for (const env of [{ GENTLE_SHELL_HOME: "agent" }, { GENTLE_PI_CONFIG_HOME: "gentle-ai" }]) {
		const w = world();
		try {
			assert.equal(await w.uninstall(["--yes"], { env }), 1);
			assert.match(w.err.join("\n"), /is not an absolute path/);
			untouched(w);
		} finally { w.cleanup(); }
	}
});

test("GENTLE_SHELL_HOME and GENTLE_PI_CONFIG_HOME select what is removed", async () => {
	const w = world();
	try {
		const custom = join(w.root, "custom-agent");
		const config = join(w.root, "custom-config");
		write(join(custom, ".gentle-shell-home"));
		write(join(config, "channel.json"));
		write(join(config, "persona.json"));
		assert.equal(await w.uninstall(["--yes"], { env: { GENTLE_SHELL_HOME: custom, GENTLE_PI_CONFIG_HOME: config } }), 0);
		assert.equal(existsSync(custom), false);
		assert.equal(existsSync(join(config, "channel.json")), false);
		assert.equal(existsSync(join(config, "persona.json")), true);
		assert.equal(existsSync(w.isolated), true, "the default isolated home is not the selected one");
		assert.equal(existsSync(w.paths.channel), true, "the default config home is not the selected one");
	} finally { w.cleanup(); }
});

test("a GENTLE_SHELL_HOME without Gentle Shell's ownership evidence is kept", async () => {
	const w = world();
	try {
		const custom = join(w.root, "projects");
		write(join(custom, "notes.txt"), "mine");
		assert.equal(await w.uninstall(["--yes"], { env: { GENTLE_SHELL_HOME: custom } }), 0);
		assert.equal(readFileSync(join(custom, "notes.txt"), "utf8"), "mine");
		assert.match(w.out.join("\n"), /projects: not created by Gentle Shell/);
	} finally { w.cleanup(); }
});

test("a GENTLE_SHELL_HOME recorded as provisioned in ~/.gentle-shell/config.json is removed", async () => {
	const w = world();
	try {
		const custom = join(w.root, "provisioned-agent");
		write(join(custom, "settings.json"));
		write(w.paths.launcherConfig, JSON.stringify({ provisioned: { [custom]: { gentleAi: "4.0.0", gentlePi: "4.0.0", at: "now" } } }));
		assert.equal(await w.uninstall(["--yes"], { env: { GENTLE_SHELL_HOME: custom } }), 0);
		assert.equal(existsSync(custom), false);
	} finally { w.cleanup(); }
});

test("symbolic links are never followed or removed", posixOnly, async () => {
	const w = world();
	try {
		const target = join(w.root, "elsewhere");
		write(join(target, ".gentle-shell-home"));
		write(join(target, "keep.txt"));
		rmSync(w.paths.main, { recursive: true });
		symlinkSync(target, w.paths.main);
		const linkedHome = join(w.root, "linked-agent");
		symlinkSync(target, linkedHome);
		assert.equal(await w.uninstall(["--yes"], { env: { GENTLE_SHELL_HOME: linkedHome } }), 0);
		assert.equal(existsSync(join(target, "keep.txt")), true);
		assert.equal(existsSync(w.paths.main), true);
		assert.equal(existsSync(linkedHome), true);
		assert.match(w.out.join("\n"), /main: a symbolic link, not followed/);
	} finally { w.cleanup(); }
});

test("custom --home homes and the user's Pi home are listed as not touched", async () => {
	const w = world();
	try {
		const persisted = join(w.root, "persisted-home");
		const provisioned = join(w.root, "provisioned-home");
		for (const dir of [persisted, provisioned]) write(join(dir, "settings.json"));
		write(w.paths.launcherConfig, JSON.stringify({ home: persisted, provisioned: { [provisioned]: { gentleAi: "4.0.0", at: "now" } } }));
		assert.equal(await w.uninstall(["--yes"]), 0);
		const plan = w.out.join("\n");
		assert.match(plan, /Not touched:/);
		for (const dir of [persisted, provisioned, w.piHome]) {
			assert.ok(plan.includes(dir), dir);
			assert.equal(existsSync(join(dir, "settings.json")), true, dir);
		}
	} finally { w.cleanup(); }
});

test("tools the installer may have added are listed with how to remove them, never removed", async () => {
	for (const platform of ["darwin", "win32"]) {
		const w = world();
		try {
			assert.equal(await w.uninstall(["--dry-run"], { platform }), 0);
			const plan = w.out.join("\n");
			assert.match(plan, /remove -g @earendil-works\/pi-coding-agent/);
			assert.match(plan, /Engram/);
			assert.match(plan, /pnpm setup/);
			assert.equal(plan.includes("%USERPROFILE%\\.pnpm"), platform === "win32", platform);
		} finally { w.cleanup(); }
	}
});

test("a failed package removal exits 1 and prints the command to run", async () => {
	const w = world();
	try {
		assert.equal(await w.uninstall(["--yes"], { runCode: 1 }), 1);
		assert.match(w.err.join("\n"), /pnpm remove -g gentle-pi/);
		assert.deepEqual(w.ownLeft(), []);
	} finally { w.cleanup(); }
});

test("~/.gentle-shell is kept when it still holds other files", async () => {
	const w = world();
	try {
		write(join(w.shell, "notes.txt"), "mine");
		assert.equal(await w.uninstall(["--yes"]), 0);
		assert.equal(readFileSync(join(w.shell, "notes.txt"), "utf8"), "mine");
	} finally { w.cleanup(); }
});

test("a failed removal stops before the package is removed", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
	const w = world();
	const locked = join(w.paths.main, "gentle-ai");
	try {
		chmodSync(locked, 0o500);
		assert.equal(await w.uninstall(["--yes"]), 1);
		assert.match(w.err.join("\n"), /could not remove/);
		assert.deepEqual(w.calls, []);
		assert.equal(existsSync(w.isolated), true, "nothing after the failure is removed");
	} finally {
		chmodSync(locked, 0o700);
		w.cleanup();
	}
});
