const assert = require("node:assert/strict");
const test = require("node:test");

const {
	DEFAULT_WATCHDOG_TARGET,
	InternetConnectivityLostError,
	InternetWatchdog,
	InternetWatchdogStartupError,
	validateAndNormalizeProbeTarget,
} = require("../dist/internetWatchdog");

function sequenceProbe(outcomes) {
	let calls = 0;
	return {
		get calls() {
			return calls;
		},
		async probe() {
			const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
			calls++;
			if (outcome instanceof Error) throw outcome;
		},
	};
}

async function waitFor(predicate, timeoutMs = 500) {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > timeoutMs) {
			throw new Error("Timed out waiting for watchdog state");
		}
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

test("watchdog target validation accepts IP addresses and hostnames", () => {
	assert.equal(validateAndNormalizeProbeTarget(" 8.8.8.8 "), "8.8.8.8");
	assert.equal(validateAndNormalizeProbeTarget("Example.COM"), "example.com");
	assert.equal(DEFAULT_WATCHDOG_TARGET, "8.8.8.8");
});

test("watchdog target validation rejects URLs, ports, and option-like values", () => {
	for (const value of [
		"",
		"https://example.com",
		"example.com:443",
		"example.com/path",
		"-c",
		"bad host",
	]) {
		assert.throws(() => validateAndNormalizeProbeTarget(value));
	}
});

test("startup validation retries and succeeds within its bounded attempts", async () => {
	const probe = sequenceProbe([new Error("drop"), undefined]);
	const watchdog = new InternetWatchdog({
		target: "8.8.8.8",
		probe,
		startupAttempts: 3,
		startupRetryDelayMs: 1,
		onConnectivityLost() {},
	});
	await watchdog.validateStartup();
	assert.equal(probe.calls, 2);
	await watchdog.stop();
});

test("startup validation fails after the configured attempt limit", async () => {
	const probe = sequenceProbe([new Error("unreachable")]);
	const watchdog = new InternetWatchdog({
		target: "unreachable.example",
		probe,
		startupAttempts: 2,
		startupRetryDelayMs: 1,
		onConnectivityLost() {},
	});
	await assert.rejects(
		watchdog.validateStartup(),
		(error) =>
			error instanceof InternetWatchdogStartupError &&
			error.code === "INTERNET_WATCHDOG_STARTUP_FAILED",
	);
	await watchdog.stop();
});

test("transient monitor failure recovers without cancelling the run", async () => {
	const probe = sequenceProbe([undefined, new Error("drop"), undefined]);
	let lost = false;
	const watchdog = new InternetWatchdog({
		target: "8.8.8.8",
		probe,
		intervalMs: 1,
		probeTimeoutMs: 10,
		failureThreshold: 2,
		onConnectivityLost() {
			lost = true;
		},
	});
	await watchdog.validateStartup();
	watchdog.start();
	await waitFor(() => probe.calls >= 3);
	assert.equal(lost, false);
	await watchdog.stop();
});

test("sustained monitor failure cancels exactly once and releases the loop", async () => {
	const probe = sequenceProbe([undefined, new Error("down")]);
	const errors = [];
	const watchdog = new InternetWatchdog({
		target: "8.8.8.8",
		probe,
		intervalMs: 1,
		probeTimeoutMs: 10,
		failureThreshold: 3,
		onConnectivityLost(error) {
			errors.push(error);
		},
	});
	await watchdog.validateStartup();
	watchdog.start();
	await waitFor(() => errors.length === 1);
	assert.equal(errors.length, 1);
	assert.ok(errors[0] instanceof InternetConnectivityLostError);
	assert.equal(errors[0].consecutiveFailures, 3);
	await watchdog.stop();
	await watchdog.stop();
	assert.equal(errors.length, 1);
});

test("stop aborts an active probe and is idempotent", async () => {
	let active = false;
	let aborted = false;
	let calls = 0;
	const probe = {
		async probe(_target, { signal }) {
			calls++;
			if (calls === 1) return;
			active = true;
			await new Promise((resolve, reject) => {
				signal.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(signal.reason);
					},
					{ once: true },
				);
			});
		},
	};
	const watchdog = new InternetWatchdog({
		target: "8.8.8.8",
		probe,
		intervalMs: 1,
		onConnectivityLost() {},
	});
	await watchdog.validateStartup();
	watchdog.start();
	await waitFor(() => active);
	await watchdog.stop();
	await watchdog.stop();
	assert.equal(aborted, true);
});
