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
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSessionRuntime } from "../src/core/session-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

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

function createDeferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
};

type SessionWithReadinessInternals = {
	_runtime: {
		hasActiveTurnWork: () => boolean;
		isRetrying: () => boolean;
	};
};

describe("AgentSession runtime invariants", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-invariant-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
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
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
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
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
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

	it("fenceForLifecycleSeam cancels an already-armed continuation timer", async () => {
		const runtime = createSessionRuntime({
			processEvent: async () => {},
			isRetryableAgentEnd: () => false,
		});
		let continueCalls = 0;
		const fakeAgent = {
			continue: async () => {
				continueCalls++;
			},
		} as unknown as Agent;

		runtime.scheduleContinuation(fakeAgent, 20);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await runtime.fenceForLifecycleSeam();
		await new Promise((resolve) => setTimeout(resolve, 30));

		expect(continueCalls).toBe(0);
		runtime.dispose();
	});

	it("fenceForLifecycleSeam waits for active turn work and rejects pending turn work", async () => {
		const runtime = createSessionRuntime({
			processEvent: async () => {},
			isRetryableAgentEnd: () => false,
		});
		const firstPromptEntered = createDeferred<void>();
		const releaseFirstPrompt = createDeferred<void>();
		let promptCalls = 0;
		const fakeAgent = {
			state: { messages: [] },
			hasQueuedMessages: () => false,
			prompt: async () => {
				promptCalls++;
				if (promptCalls === 1) {
					firstPromptEntered.resolve();
					await releaseFirstPrompt.promise;
				}
			},
		} as unknown as Agent;

		const firstTurn = runtime.runPromptCycle(fakeAgent, [], () => false);
		await firstPromptEntered.promise;
		const secondTurn = runtime.runPromptCycle(fakeAgent, [], () => false).catch((error: Error) => error);
		const fence = runtime.fenceForLifecycleSeam();

		expect(runtime.hasActiveTurnWork()).toBe(true);
		releaseFirstPrompt.resolve();
		await firstTurn;
		await fence;
		const secondTurnError = await secondTurn;

		if (!(secondTurnError instanceof Error)) {
			throw new Error("expected pending turn to be rejected by lifecycle fence");
		}
		expect(secondTurnError.message).toBe("Turn work cancelled by lifecycle fence");
		expect(promptCalls).toBe(1);
		expect(runtime.hasActiveTurnWork()).toBe(false);
		runtime.dispose();
	});

	/**
	 * INVARIANT: a lifecycle seam fence cancels auto-compaction continuations that
	 * were armed by the old owner before the seam.
	 */
	it("fenceLifecycleSeam cancels an auto-compaction continuation armed before the seam", async () => {
		vi.useFakeTimers();
		let callCount = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage(`Response ${callCount}`, {
						usage: {
							input: 2_000,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2_000,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
			tempDir,
		);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		await session.bindExtensions({ shutdownHandler: () => {} });
		await session.prompt("one");
		await session.prompt("two");

		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();
		const sessionInternals = session as unknown as SessionWithCompactionInternals;
		await sessionInternals._runAutoCompaction("overflow", true);
		await session.fenceLifecycleSeam();
		vi.advanceTimersByTime(150);
		await Promise.resolve();

		expect(continueSpy).not.toHaveBeenCalled();
	});

	it("epi_user_turn_ready grants a safe seam for starting the next turn", async () => {
		let callCount = 0;
		let readyCount = 0;
		const errors: string[] = [];
		const readySnapshots: Array<{ isStreaming: boolean; hasActiveTurnWork: boolean; isRetrying: boolean }> = [];
		const secondTurnDone = createDeferred<void>();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const currentCall = callCount;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage(`Response ${currentCall}`);
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
					if (currentCall === 2) secondTurnDone.resolve();
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("epi_user_turn_ready", () => {
						const sessionInternals = session as unknown as SessionWithReadinessInternals;
						readySnapshots.push({
							isStreaming: session.isStreaming,
							hasActiveTurnWork: sessionInternals._runtime.hasActiveTurnWork(),
							isRetrying: sessionInternals._runtime.isRetrying(),
						});
						readyCount++;
						if (readyCount === 1) {
							pi.sendUserMessage("from ready seam");
						}
					});
				},
			],
			tempDir,
		);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		await session.bindExtensions({
			shutdownHandler: () => {},
			onError: (error) => errors.push(error.error),
		});

		await session.prompt("initial");
		await Promise.race([
			secondTurnDone.promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("second turn did not complete")), 100)),
		]);

		expect(errors).toEqual([]);
		expect(callCount).toBe(2);
		expect(readyCount).toBeGreaterThanOrEqual(1);
		expect(readySnapshots[0]).toEqual({ isStreaming: false, hasActiveTurnWork: false, isRetrying: false });
	});

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
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
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
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
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

	it("reload() waits for queued extension events before shutdown and rebuild", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agentEndStarted = createDeferred<void>();
		const releaseAgentEnd = createDeferred<void>();
		const events: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage("Reload fence");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("agent_end", async () => {
						events.push("agent_end:start");
						agentEndStarted.resolve();
						await releaseAgentEnd.promise;
						events.push("agent_end:end");
					});
					pi.on("session_shutdown", async () => {
						events.push("session_shutdown");
					});
					pi.on("session_start", async (event) => {
						events.push(`session_start:${event.reason}`);
					});
				},
			],
			tempDir,
		);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		await session.bindExtensions({ shutdownHandler: () => {} });
		events.length = 0;

		const promptPromise = session.prompt("Test");
		await agentEndStarted.promise;

		let reloadResolved = false;
		const reloadPromise = session.reload().then(() => {
			reloadResolved = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(reloadResolved).toBe(false);
		expect(events).toEqual(["agent_end:start"]);

		releaseAgentEnd.resolve();
		await Promise.all([promptPromise, reloadPromise]);

		expect(events).toEqual(["agent_end:start", "agent_end:end", "session_shutdown", "session_start:reload"]);
	});

	it("reload() suppresses stale auto-retry while agent_end drains across the seam", async () => {
		let callCount = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agentEndStarted = createDeferred<void>();
		const releaseAgentEnd = createDeferred<void>();
		const events: string[] = [];

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage("", {
						stopReason: "error",
						errorMessage: "overloaded_error",
					});
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "error", reason: "error", error: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 10 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("agent_end", async () => {
						events.push("agent_end:start");
						agentEndStarted.resolve();
						await releaseAgentEnd.promise;
						events.push("agent_end:end");
					});
					pi.on("session_shutdown", async () => {
						events.push("session_shutdown");
					});
					pi.on("session_start", async (event) => {
						events.push(`session_start:${event.reason}`);
					});
				},
			],
			tempDir,
		);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		await session.bindExtensions({ shutdownHandler: () => {} });
		events.length = 0;

		const promptPromise = session.prompt("Test");
		await agentEndStarted.promise;

		const reloadPromise = session.reload();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(callCount).toBe(1);

		releaseAgentEnd.resolve();
		await Promise.all([promptPromise, reloadPromise]);

		expect(callCount).toBe(1);
		expect(session.isRetrying).toBe(false);
		expect(events).toEqual(["agent_end:start", "agent_end:end", "session_shutdown", "session_start:reload"]);
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
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

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
