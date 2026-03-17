import { describe, expect, it } from "vitest";
import { shouldEmitEpiUserTurnReady } from "../src/core/user-turn-ready.js";

describe("shouldEmitEpiUserTurnReady", () => {
	it("returns true only when the host is fully idle after post-turn work", () => {
		expect(
			shouldEmitEpiUserTurnReady({
				isStreaming: false,
				hasQueuedMessages: false,
				isCompacting: false,
				isRetrying: false,
			}),
		).toBe(true);
	});

	it("returns false while compaction is still running", () => {
		expect(
			shouldEmitEpiUserTurnReady({
				isStreaming: false,
				hasQueuedMessages: false,
				isCompacting: true,
				isRetrying: false,
			}),
		).toBe(false);
	});

	it("returns false while queued continuation work still exists", () => {
		expect(
			shouldEmitEpiUserTurnReady({
				isStreaming: false,
				hasQueuedMessages: true,
				isCompacting: false,
				isRetrying: false,
			}),
		).toBe(false);
	});

	it("returns false while retry recovery is still active", () => {
		expect(
			shouldEmitEpiUserTurnReady({
				isStreaming: false,
				hasQueuedMessages: false,
				isCompacting: false,
				isRetrying: true,
			}),
		).toBe(false);
	});
});
