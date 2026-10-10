import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PI_INSTALL_VERSION } from "../scripts/installer-preflight.mjs";
import { CHANNEL_SCHEMA, MainChannelError, readChannel, runUpgrade, writeChannel } from "../scripts/main-channel.mjs";

const AI_SHA = "1f9d5e6423e37f7d2316859045f379ba9b5d8c3a";
const SHELL_SHA = "6e7e3a18f794223396527a54c7c36d19c7d236c6";
const NEW_AI = "2222222222222222222222222222222222222222";
const NEW_SHELL = "3333333333333333333333333333333333333333";
const posixOnly = { skip: process.platform === "win32" };
type Call = { command: string; argv: string[] };

/** A sandboxed home with a pnpm- or npm-owned package root and fake network/processes. */
// pnpm upgrades gentle-pi in one global group with the installer's Pi (`pi@<pin>,<spec>`).
const PI_GROUP = `@earendil-works/pi-coding-agent@${PI_INSTALL_VERSION}`;
const PNPM_LIST = "list -g --depth 0 --json";
const piListing = (version: string) => ({ code: 0, stdout: JSON.stringify([{ dependencies: { "@earendil-works/pi-coding-agent": { version } } }]) });

function world({ owner = "pnpm", latest = "4.1.0", commits = { ai: AI_SHA, shell: SHELL_SHA }, tools = ["go", "pnpm", "npm"],
	list = { code: 0, stdout: "[]" } as { code: number; stdout: string } } = {}) {
	// owner "linked": `npm link` of a source checkout, so npm's global entry points outside npm's root.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "upgrade-")));
	const home = join(root, "home");
	const pnpmHome = join(root, "pnpm");
	const npmRoot = join(root, "npm", "lib", "node_modules");
	mkdirSync(npmRoot, { recursive: true });
	const packageRoot = owner === "pnpm" ? join(pnpmHome, "global", "v11", "x", "node_modules", "gentle-pi")
		: owner === "npm" ? join(npmRoot, "gentle-pi") : join(root, "checkout");
	mkdirSync(packageRoot, { recursive: true });
	mkdirSync(home);
	const ctx = { env: { PNPM_HOME: pnpmHome }, home };
	const calls: Call[] = [];
	const lines: string[] = [];
	const fetches: string[] = [];
	const fetch = async (url: string) => {
		fetches.push(url);
		if (url === "https://registry.npmjs.org/gentle-pi/latest") return { ok: latest !== "", status: latest ? 200 : 503, json: async () => ({ version: latest }) };
		if (url.endsWith("/gentle-ai/commits/main")) return { ok: true, status: 200, text: async () => commits.ai };
		if (url.endsWith("/gentle-shell/commits/main")) return { ok: true, status: 200, text: async () => commits.shell };
		if (url.startsWith("https://codeload.github.com/")) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("src").buffer };
		throw new Error(`unexpected fetch ${url}`);
	};
	const run = async (command: string, argv: string[], options: { env?: Record<string, string>; cwd?: string }) => {
		if (command === "/usr/bin/npm" && argv.join(" ") === "root -g") return { code: 0, stdout: `${npmRoot}\n` };
		calls.push({ command, argv });
		if (command === "/usr/bin/pnpm" && argv.join(" ") === PNPM_LIST) return list;
		if (argv[0] === "install" && argv[1]?.includes("gentle-ai/v4/cmd/gentle-ai@")) {
			mkdirSync(options.env!.GOBIN, { recursive: true });
			writeFileSync(join(options.env!.GOBIN, "gentle-ai"), "#!/bin/sh\n", { mode: 0o755 });
			return { code: 0, stdout: "" };
		}
		if (argv[0] === "version") {
			const sha = command.split("/").at(-2) ?? "";
			return { code: 0, stdout: `gentle-ai 4.0.1-0.20261008202137-${sha.slice(0, 12)}\n` };
		}
		if (command === "tar") {
			writeFileSync(join(argv[argv.indexOf("-C") + 1], "package.json"), JSON.stringify({ name: "gentle-pi", version: "4.1.0", scripts: { prepack: "x" } }));
			return { code: 0, stdout: "" };
		}
		if (argv[0] === "pack") {
			const version = JSON.parse(readFileSync(join(options.cwd!, "package.json"), "utf8")).version;
			writeFileSync(join(argv[argv.indexOf("--pack-destination") + 1], `gentle-pi-${version}.tgz`), "tgz");
		}
		return { code: 0, stdout: "" };
	};
	const which = async (name: string) => (tools.includes(name) ? `/usr/bin/${name}` : null);
	const upgrade = (args: string[], currentVersion = "4.0.0") => runUpgrade({ args, ctx, platform: "darwin", packageRoot, currentVersion,
		adapters: { fetch, run, fs: fsPromises, which }, out: (line: string) => lines.push(line) });
	const installs = () => calls.filter((call) => ["add", "install"].includes(call.argv[0]) && !call.argv[1]?.includes("cmd/gentle-ai@"))
		.map((call) => `${call.command} ${call.argv.join(" ")}`);
	return { root, home, ctx, calls, lines, fetches, upgrade, installs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a release install that is already the latest release changes nothing", async () => {
	const w = world({ latest: "4.0.0" });
	try {
		assert.equal(await w.upgrade([]), 0);
		assert.deepEqual(w.lines, ["gentle-shell 4.0.0 is already the latest release."]);
		assert.deepEqual(w.calls, []);
		assert.deepEqual(w.fetches, ["https://registry.npmjs.org/gentle-pi/latest"]);
	} finally { w.cleanup(); }
});

test("a release install updates to the latest release with the package manager that owns it", async () => {
	for (const [owner, expected] of [["pnpm", `/usr/bin/pnpm add -g ${PI_GROUP},gentle-pi@4.1.0 --allow-build=gentle-pi`], ["npm", "/usr/bin/npm install -g gentle-pi@4.1.0"]]) {
		const w = world({ owner });
		try {
			assert.equal(await w.upgrade([]), 0);
			assert.deepEqual(w.installs(), [expected]);
			assert.deepEqual(w.lines, ["Updated gentle-shell 4.0.0 to 4.1.0 (release)."]);
			assert.deepEqual(await readChannel(w.ctx, fsPromises), { channel: "release" });
		} finally { w.cleanup(); }
	}
});

test("a pnpm upgrade adds the installer's Pi with gentle-pi in one group, and refuses to replace a newer pnpm Pi", async () => {
	// No pnpm Pi, or one at the pin or older: one grouped add after reading pnpm's list.
	for (const list of [{ code: 0, stdout: "[]" }, piListing(PI_INSTALL_VERSION), piListing("0.99.5")]) {
		const w = world({ list });
		try {
			assert.equal(await w.upgrade([]), 0);
			assert.deepEqual(w.calls.map((call) => `${call.command} ${call.argv.join(" ")}`),
				[`/usr/bin/pnpm ${PNPM_LIST}`, `/usr/bin/pnpm add -g ${PI_GROUP},gentle-pi@4.1.0 --allow-build=gentle-pi`]);
		} finally { w.cleanup(); }
	}
	// A newer pnpm Pi is never downgraded: a named refusal, nothing installed or recorded.
	const newer = world({ list: piListing("1.1.0") });
	try {
		await assert.rejects(newer.upgrade([]), (error: MainChannelError) => error.code === "upgrade-pi-newer" &&
			error.message === `upgrade-pi-newer: Pi 1.1.0, installed globally with pnpm, is newer than Pi ${PI_INSTALL_VERSION}, the version Gentle Shell runs, ` +
				"and pnpm updates Gentle Shell together with its Pi, which would replace it. Nothing was changed; " +
				"remove it with `pnpm remove -g @earendil-works/pi-coding-agent`, then run `gentle-shell upgrade` again.");
		assert.deepEqual(newer.installs(), []);
		assert.equal(existsSync(join(newer.home, ".pi", "gentle-ai", "channel.json")), false);
	} finally { newer.cleanup(); }
	// pnpm's list must be readable before anything is replaced.
	for (const list of [{ code: 1, stdout: "" }, { code: 0, stdout: "not json" }, { code: 0, stdout: "{}" }]) {
		const w = world({ list });
		try {
			await assert.rejects(w.upgrade([]), (error: MainChannelError) => error.code === "upgrade-list-unavailable", list.stdout);
			assert.deepEqual(w.installs(), []);
		} finally { w.cleanup(); }
	}
	// npm owns its Shell and its own Pi: pnpm's list is not read.
	const npm = world({ owner: "npm", list: piListing("1.1.0") });
	try {
		assert.equal(await npm.upgrade([]), 0);
		assert.deepEqual(npm.calls.map((call) => `${call.command} ${call.argv.join(" ")}`), ["/usr/bin/npm install -g gentle-pi@4.1.0"]);
	} finally { npm.cleanup(); }
});

test("a Gentle Shell that neither pnpm nor npm owns, such as an npm-linked checkout, is never reinstalled", async () => {
	const w = world({ owner: "linked" });
	try {
		await assert.rejects(w.upgrade([]), (error: MainChannelError) => error.code === "upgrade-owner-unknown");
		assert.deepEqual(w.installs(), []);
	} finally { w.cleanup(); }
});

test("an unreachable registry fails without installing anything", async () => {
	const w = world({ latest: "" });
	try {
		await assert.rejects(w.upgrade([]), (error: MainChannelError) => error.code === "latest-release-unavailable");
		assert.deepEqual(w.calls, []);
	} finally { w.cleanup(); }
});

test("a main install already at both latest main commits changes nothing", async () => {
	const w = world();
	try {
		await writeChannel(w.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		assert.equal(await w.upgrade([], "4.0.0-main.6e7e3a18f794"), 0);
		assert.deepEqual(w.lines, ["gentle-shell is already at the latest main: Gentle Shell 6e7e3a18f794, Gentle AI 1f9d5e6423e3."]);
		assert.deepEqual(w.calls, []);
	} finally { w.cleanup(); }
});

test("a main install rebuilds only what moved on main and records the new commits", posixOnly, async () => {
	const w = world({ commits: { ai: NEW_AI, shell: NEW_SHELL } });
	try {
		await writeChannel(w.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		assert.equal(await w.upgrade([], "4.0.0-main.6e7e3a18f794"), 0);
		assert.ok(w.calls.some((call) => call.argv.join(" ") === `install github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@${NEW_AI}`));
		const tgz = join(w.home, ".pi", "gentle-ai", "main", "packages", "gentle-pi-4.1.0-main.333333333333.tgz");
		assert.deepEqual(w.installs(), [`/usr/bin/pnpm add -g ${PI_GROUP},${tgz} --allow-build=gentle-pi`]);
		assert.deepEqual(await readChannel(w.ctx, fsPromises), { channel: "main", shellCommit: NEW_SHELL, gentleAiCommit: NEW_AI });
		assert.deepEqual(w.lines, ["Updated to the latest main: Gentle Shell 333333333333, Gentle AI 222222222222."]);
	} finally { w.cleanup(); }
});

test("a main upgrade refuses a newer pnpm Pi, or a config folder pnpm would split, before building anything", posixOnly, async () => {
	const newer = world({ commits: { ai: NEW_AI, shell: NEW_SHELL }, list: piListing("1.1.0") });
	try {
		await writeChannel(newer.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		await assert.rejects(newer.upgrade([], "4.0.0-main.6e7e3a18f794"), (error: MainChannelError) => error.code === "upgrade-pi-newer");
		assert.deepEqual(newer.calls.map((call) => `${call.command} ${call.argv.join(" ")}`), [`/usr/bin/pnpm ${PNPM_LIST}`]);
		assert.equal(existsSync(join(newer.home, ".pi", "gentle-ai", "dev-binary.json")), false);
		assert.deepEqual(await readChannel(newer.ctx, fsPromises), { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA });
	} finally { newer.cleanup(); }
	const comma = world({ commits: { ai: NEW_AI, shell: NEW_SHELL } });
	try {
		const ctx = { ...comma.ctx, home: join(comma.root, "ho,me") };
		mkdirSync(ctx.home);
		await assert.rejects(runUpgrade({ args: ["--channel", "main"], ctx, platform: "darwin", packageRoot: join(comma.root, "pnpm", "global", "v11", "x", "node_modules", "gentle-pi"),
			currentVersion: "4.0.0", adapters: { fetch: async (url: string) => ({ ok: true, status: 200, text: async () => (url.includes("gentle-ai") ? NEW_AI : NEW_SHELL) }),
				run: async (command: string, argv: string[]) => { comma.calls.push({ command, argv }); return { code: 0, stdout: "[]" }; },
				fs: fsPromises, which: async (name: string) => `/usr/bin/${name}` }, out: () => {} }),
			(error: MainChannelError) => error.code === "upgrade-install-failed" && /contains a comma/.test(error.message));
		// Only npm's root was read to find the owner: nothing was listed, built or added.
		assert.deepEqual(comma.calls.map((call) => call.argv.join(" ")), ["root -g"]);
	} finally { comma.cleanup(); }
});

test("a main install whose Gentle AI did not move rebuilds only Gentle Shell", posixOnly, async () => {
	const w = world({ commits: { ai: AI_SHA, shell: NEW_SHELL } });
	try {
		await writeChannel(w.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		assert.equal(await w.upgrade([], "4.0.0-main.6e7e3a18f794"), 0);
		assert.equal(w.calls.some((call) => call.argv[1]?.includes("cmd/gentle-ai@")), false);
		assert.equal(w.installs().length, 1);
	} finally { w.cleanup(); }
});

test("--channel main switches a release install to both latest main commits", posixOnly, async () => {
	const w = world();
	try {
		assert.equal(await w.upgrade(["--channel", "main"]), 0);
		assert.ok(w.calls.some((call) => call.argv[1] === `github.com/gentleman-programming/gentle-ai/v4/cmd/gentle-ai@${AI_SHA}`));
		assert.equal(w.installs().length, 1);
		assert.deepEqual(await readChannel(w.ctx, fsPromises), { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA });
		assert.deepEqual(JSON.parse(readFileSync(join(w.home, ".pi", "gentle-ai", "dev-binary.json"), "utf8")).path,
			join(w.home, ".pi", "gentle-ai", "main", "gentle-ai", AI_SHA, "gentle-ai"));
	} finally { w.cleanup(); }
});

test("--channel release switches a main install back and removes only the main override", async () => {
	const w = world();
	try {
		await writeChannel(w.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		const registration = join(w.home, ".pi", "gentle-ai", "dev-binary.json");
		writeFileSync(registration, JSON.stringify({ schema: "gentle-pi.dev-binary/v1", path: join(w.home, ".pi", "gentle-ai", "main", "gentle-ai", AI_SHA, "gentle-ai") }));
		assert.equal(await w.upgrade(["--channel=release"], "4.0.0-main.6e7e3a18f794"), 0);
		assert.deepEqual(w.installs(), [`/usr/bin/pnpm add -g ${PI_GROUP},gentle-pi@4.1.0 --allow-build=gentle-pi`]);
		assert.equal(existsSync(registration), false);
		assert.deepEqual(JSON.parse(readFileSync(join(w.home, ".pi", "gentle-ai", "channel.json"), "utf8")), { schema: CHANNEL_SCHEMA, channel: "release" });
	} finally { w.cleanup(); }
});

test("switching to release keeps a dev binary the user registered themselves", async () => {
	const w = world();
	try {
		await writeChannel(w.ctx, { channel: "main", shellCommit: SHELL_SHA, gentleAiCommit: AI_SHA }, fsPromises);
		const registration = join(w.home, ".pi", "gentle-ai", "dev-binary.json");
		writeFileSync(registration, JSON.stringify({ schema: "gentle-pi.dev-binary/v1", path: "/Users/me/src/gentle-ai/gentle-ai" }));
		assert.equal(await w.upgrade(["--channel", "release"], "4.0.0-main.6e7e3a18f794"), 0);
		assert.equal(existsSync(registration), true);
	} finally { w.cleanup(); }
});

test("main needs Go and pnpm on PATH", async () => {
	for (const tools of [["pnpm", "npm"], ["go", "npm"]]) {
		const w = world({ tools });
		try {
			await assert.rejects(w.upgrade(["--channel", "main"]), (error: MainChannelError) => error.code === "main-requires-tools");
			assert.deepEqual(w.calls, []);
		} finally { w.cleanup(); }
	}
});

test("unknown upgrade arguments are a usage error", async () => {
	for (const args of [["--channel"], ["--channel", "nightly"], ["--force"], ["main"]]) {
		const w = world();
		try {
			await assert.rejects(w.upgrade(args), (error: MainChannelError) => error.code === "upgrade-usage");
			assert.deepEqual(w.calls, []);
			assert.deepEqual(w.fetches, []);
		} finally { w.cleanup(); }
	}
});
