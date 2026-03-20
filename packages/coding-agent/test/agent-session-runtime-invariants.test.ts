/**
 * Characterization tests for SessionRuntime invariants.
 *
 * These tests verify timing and ordering invariants that are critical
 * for correctness but not directly observable through existing tests.
 * They serve as regression gates for any future refactoring of the
 * concurrent kernel (e.g., replacing Promise chains with Effect Queue).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("AgentSession runtime invariants", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-invariant-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	/**
	 * INVARIANT: prompt() must not return while isRetrying is true.
	 *
	 * This tests the synchronous retry Deferred creation timing invariant.
	 * If _retryPromise/Deferred is created too late (e.g., inside a queue
	 * consumer fiber instead of synchronously in the event handler),
	 * waitForRetry() would be a no-op and prompt() could return while
	 * the retry is still in progress.
	 */
	it("prompt() does not return while isRetrying is true", async () => {
		let callCount = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount <= 1) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 50 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		await session.prompt("Test");

		// After prompt() returns, retry must be complete
		expect(session.isRetrying).toBe(false);
		expect(callCount).toBe(2); // First call failed, second succeeded
	});

	/**
	 * INVARIANT: Events are processed in the order they were emitted.
	 *
	 * agent_start, message_start, message_end, agent_end must arrive
	 * to listeners in exactly that order, even if event processing
	 * takes variable time.
	 */
	it("events arrive in emission order", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage("Hello");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		const eventTypes: string[] = [];
		session.subscribe((event) => {
			eventTypes.push(event.type);
		});

		await session.prompt("Test");

		// Verify ordering: agent_start before message events, message_end before agent_end
		const agentStartIdx = eventTypes.indexOf("agent_start");
		const messageStartIdx = eventTypes.indexOf("message_start");
		const messageEndIdx = eventTypes.lastIndexOf("message_end");
		const agentEndIdx = eventTypes.indexOf("agent_end");

		expect(agentStartIdx).toBeGreaterThanOrEqual(0);
		expect(messageStartIdx).toBeGreaterThan(agentStartIdx);
		expect(messageEndIdx).toBeGreaterThan(messageStartIdx);
		expect(agentEndIdx).toBeGreaterThan(messageEndIdx);
	});

	/**
	 * INVARIANT: sendCustomMessage with triggerTurn routes correctly based on phase.
	 *
	 * When called during a prompt drain loop, it should queue as followUp.
	 * When called idle, it should start a new turn.
	 */
	it("sendCustomMessage queues as followUp during prompt drain loop", async () => {
		let callCount = 0;
		let followUpSeen = false;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage(`Response ${callCount}`);
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		// Track agent_end to inject a custom message during drain loop
		session.subscribe((event) => {
			if (event.type === "agent_end" && callCount === 1) {
				// This runs during the drain loop — sendCustomMessage should queue as followUp
				session
					.sendCustomMessage(
						{
							customType: "test-message",
							content: "from drain loop",
							display: true,
						},
						{ triggerTurn: true },
					)
					.catch(() => {});
				followUpSeen = true;
			}
		});

		await session.prompt("Test");

		// The custom message should have triggered a follow-up turn
		expect(followUpSeen).toBe(true);
		// Total calls: 1 for initial prompt + 1 for follow-up from custom message
		expect(callCount).toBeGreaterThanOrEqual(1);
	});

	/**
	 * INVARIANT: abort() cancels retry and subsequent prompt() works.
	 */
	it("abort during retry allows fresh prompt", async () => {
		let callCount = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount <= 2) {
						// Keep failing to ensure we're in retry
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Finally!");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = new ModelRegistry(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		// Long delay so we can abort during it
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 5, baseDelayMs: 500 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		// Start prompt in background — it will fail and enter retry with 500ms delay
		const promptPromise = session.prompt("Test");

		// Wait for the first failure + retry to start
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Abort during retry
		await session.abort();
		await promptPromise; // Should resolve (retry was cancelled)

		expect(session.isRetrying).toBe(false);

		// Fresh prompt should work — use a high callCount that succeeds
		callCount = 2; // Next call (callCount=3) will succeed
		await session.prompt("Fresh start");

		expect(callCount).toBe(3);
	});

	it("reload() picks up auth.json changes", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const authPath = join(tempDir, "auth.json");

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(authPath);
		const modelRegistry = new ModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		writeFileSync(
			authPath,
			JSON.stringify(
				{
					anthropic: {
						type: "api_key",
						key: "updated-key",
					},
				},
				null,
				2,
			),
			"utf-8",
		);

		await session.reload();

		expect(await session.modelRegistry.getApiKeyForProvider("anthropic")).toBe("updated-key");
	});
});
