const assert = require("node:assert/strict");
const test = require("node:test");

const {
	PipelineCancellationController,
	abortableDelay,
	throwIfCancelled,
} = require("../dist/pipelineCancellation");

test("pipeline cancellation is first-writer-wins and idempotent", () => {
	const cancellation = new PipelineCancellationController();
	const first = new Error("internet lost");
	const second = new Error("SIGINT");
	assert.equal(cancellation.cancel({ kind: "watchdog", error: first }), true);
	assert.equal(
		cancellation.cancel({ kind: "signal", signal: "SIGINT", error: second }),
		false,
	);
	assert.equal(cancellation.cause.error, first);
	assert.throws(() => throwIfCancelled(cancellation.signal), first);
});

test("abortable pipeline delay rejects promptly with the cancellation reason", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled");
	const pending = abortableDelay(60_000, controller.signal);
	controller.abort(reason);
	await assert.rejects(pending, (error) => {
		assert.equal(controller.signal.reason, reason);
		return error.name === "AbortError";
	});
});
