/**
 * session-runtime.ts — Concurrent state machine kernel for AgentSession.
 *
 * Extracts the ~600 lines of interleaved concurrent coordination from agent-session.ts
 * into a focused module with explicit invariants. Replaces:
 *   - Promise chain (_agentEventQueue.then(...)) for serial event processing
 *   - Boolean _isInPromptDrainLoop → Phase type
 *   - Manual retry state (_retryPromise/_retryResolve/_retryAttempt) → RetryState
 *   - setTimeout escape hatches → scheduleContinuation
 *
 * Design constraints (from analysis):
 *   1. Agent owns steering/followUp queues — we call agent.followUp()/steer(), not our own queues
 *   2. emitToolCall runs OUTSIDE this runtime (in tool's execute closure) — don't touch it
 *   3. Retry Deferred must be created synchronously in event handler (pre-queue hook)
 *   4. hasQueuedMessages() is synchronous — Agent.hasQueuedMessages() reads Agent's internal arrays
 *   5. Events are processed serially, in order
 *   6. Continuation scheduling replaces setTimeout(() => agent.continue().catch({}), N)
 */

import type { Agent, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";

// ============================================================================
// Phase — replaces boolean _isInPromptDrainLoop + isStreaming checks
// ============================================================================

export type Phase = "Idle" | "PromptDrainLoop" | "Compacting";

// ============================================================================
// ManualDeferred — synchronous Promise + resolve/reject (used for retry invariant)
// ============================================================================

interface ManualDeferred {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
}

function createManualDeferred(): ManualDeferred {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

// ============================================================================
// RetryState — replaces _retryPromise/_retryResolve/_retryAttempt/_retryAbortController
// ============================================================================

export interface RetryState {
	readonly attempt: number;
	readonly deferred: ManualDeferred | null;
	readonly abortController: AbortController | null;
}

const initialRetryState: RetryState = {
	attempt: 0,
	deferred: null,
	abortController: null,
};

// ============================================================================
// SessionRuntime — the concurrent kernel
// ============================================================================

export interface SessionRuntime {
	/**
	 * Subscribe to agent events. The handler enqueues events for serial processing
	 * and synchronously creates retry Deferred when agent_end contains retryable error.
	 *
	 * Returns unsubscribe function.
	 */
	readonly subscribeToAgent: (agent: Agent) => () => void;

	/**
	 * Run a prompt drain loop: set phase to PromptDrainLoop, await agent.prompt(),
	 * drain event queue, continue while agent has queued messages, then wait for retry.
	 *
	 * This replaces the prompt() concurrent coordination (lines 949-975 of old code).
	 */
	readonly runPromptCycle: (
		agent: Agent,
		messages: AgentMessage[],
		isAbortedOrError: (msg: AgentMessage | undefined) => boolean,
	) => Promise<void>;

	/**
	 * Run a custom-message-triggered drain loop (sendCustomMessage with triggerTurn).
	 * Same structure as runPromptCycle but uses agent.prompt(singleMessage).
	 */
	readonly runCustomMessageCycle: (
		agent: Agent,
		message: AgentMessage,
		isAbortedOrError: (msg: AgentMessage | undefined) => boolean,
	) => Promise<void>;

	/**
	 * Drain the event queue — waits for all queued event processors to complete.
	 * Equivalent to: await this._agentEventQueue
	 */
	readonly drainEventQueue: () => Promise<void>;

	/**
	 * Fence a lifecycle seam. Cancels delayed continuation/retry work owned by
	 * the current runtime, then drains all already-accepted queued event work.
	 * Resolves only once the old runtime no longer has async authority.
	 */
	readonly fenceForLifecycleSeam: () => Promise<void>;

	/**
	 * Whether a lifecycle seam fence is currently active.
	 * Used by callers to suppress starting new retry/continuation work while
	 * already-accepted old-owner events are draining.
	 */
	readonly isLifecycleFenceActive: () => boolean;

	/**
	 * Check current phase synchronously.
	 */
	readonly getPhase: () => Phase;

	/**
	 * Check if in prompt drain loop (synchronous, for sendCustomMessage routing).
	 */
	readonly isInPromptDrainLoop: () => boolean;

	/**
	 * Get current retry attempt count (synchronous).
	 */
	readonly getRetryAttempt: () => number;

	/**
	 * Check if retry is in progress (synchronous).
	 */
	readonly isRetrying: () => boolean;

	/**
	 * Wait for any pending retry to complete.
	 */
	readonly waitForRetry: () => Promise<void>;

	/**
	 * Abort current retry.
	 */
	readonly abortRetry: () => void;

	/**
	 * Reset retry state (called on successful response).
	 */
	readonly resetRetryOnSuccess: () => { previousAttempt: number };

	/**
	 * Increment retry attempt and set up Deferred if not already set.
	 * Returns current attempt number.
	 */
	readonly incrementRetry: () => number;

	/**
	 * Register the abort controller for the currently sleeping retry backoff.
	 */
	readonly setRetryAbortController: (abortController: AbortController) => void;

	/**
	 * Clear the abort controller for the currently sleeping retry backoff.
	 * No-op if a newer retry replaced it.
	 */
	readonly clearRetryAbortController: (abortController: AbortController) => void;

	/**
	 * Resolve the retry Deferred (called when retry completes or is cancelled).
	 */
	readonly resolveRetry: () => void;

	/**
	 * Schedule a continuation (replaces setTimeout(() => agent.continue().catch(() => {}), N)).
	 * The fiber runs detached and is cancelled on abort().
	 */
	readonly scheduleContinuation: (agent: Agent, delayMs: number) => void;

	/**
	 * Abort everything: cancel continuation fibers, abort retry.
	 */
	readonly abortAll: () => void;

	/**
	 * Dispose the runtime (cancel consumer fiber, clean up).
	 */
	readonly dispose: () => void;
}

// ============================================================================
// Implementation
// ============================================================================

export interface SessionRuntimeDeps {
	/** Called for each event in serial order */
	processEvent: (event: AgentEvent) => Promise<void>;
	/** Called synchronously to check if agent_end has retryable error */
	isRetryableAgentEnd: (event: AgentEvent) => boolean;
}

export function createSessionRuntime(deps: SessionRuntimeDeps): SessionRuntime {
	// --- State ---
	let phase: Phase = "Idle";
	let retryState: RetryState = { ...initialRetryState };

	// Event queue: Promise chain for serial processing (same semantics as original)
	// We use a simple Promise chain here because:
	// 1. It has the exact same microtask ordering as the original _agentEventQueue.then(...)
	// 2. The synchronous retry Deferred creation happens BEFORE enqueueing
	// 3. No Effect runtime overhead for the hot path
	let eventQueue: Promise<void> = Promise.resolve();

	// Continuation fibers (setTimeout replacements)
	let continuationTimer: ReturnType<typeof setTimeout> | null = null;
	let continuationGeneration = 0;
	let lifecycleFenceDepth = 0;

	// --- Event subscription ---
	function subscribeToAgent(agent: Agent): () => void {
		const handler = (event: AgentEvent): void => {
			// SYNCHRONOUS: Create retry Deferred before async queue processing
			// This preserves the invariant that waitForRetry() can see the Deferred
			// before the queue consumer processes agent_end.
			if (event.type === "agent_end" && !retryState.deferred) {
				if (deps.isRetryableAgentEnd(event)) {
					const deferred = createManualDeferred();
					retryState = { ...retryState, deferred };
				}
			}

			// Enqueue for serial processing
			eventQueue = eventQueue.then(
				() => deps.processEvent(event),
				() => deps.processEvent(event),
			);
			eventQueue.catch(() => {});
		};

		return agent.subscribe(handler);
	}

	// --- Drain ---
	async function drainEventQueue(): Promise<void> {
		await eventQueue;
	}

	async function fenceForLifecycleSeam(): Promise<void> {
		lifecycleFenceDepth++;
		continuationGeneration++;
		cancelContinuation();
		abortRetry();
		try {
			await drainEventQueue();
		} finally {
			lifecycleFenceDepth--;
		}
	}

	function isLifecycleFenceActive(): boolean {
		return lifecycleFenceDepth > 0;
	}

	// --- Prompt cycle ---
	async function runPromptCycle(
		agent: Agent,
		messages: AgentMessage[],
		isAbortedOrError: (msg: AgentMessage | undefined) => boolean,
	): Promise<void> {
		phase = "PromptDrainLoop";
		try {
			await agent.prompt(messages);
			await eventQueue;

			let drainCount = 0;
			while (agent.hasQueuedMessages() && drainCount++ < 50) {
				const lastMsg = agent.state.messages[agent.state.messages.length - 1];
				if (isAbortedOrError(lastMsg)) break;
				await agent.continue();
				await eventQueue;
			}
		} finally {
			phase = "Idle";
		}
		await waitForRetry();
	}

	async function runCustomMessageCycle(
		agent: Agent,
		message: AgentMessage,
		isAbortedOrError: (msg: AgentMessage | undefined) => boolean,
	): Promise<void> {
		phase = "PromptDrainLoop";
		try {
			await agent.prompt(message);
			await eventQueue;

			let drainCount = 0;
			while (agent.hasQueuedMessages() && drainCount++ < 50) {
				const lastMsg = agent.state.messages[agent.state.messages.length - 1];
				if (isAbortedOrError(lastMsg)) break;
				await agent.continue();
				await eventQueue;
			}
		} finally {
			phase = "Idle";
		}
		await waitForRetry();
	}

	// --- Phase ---
	function getPhase(): Phase {
		return phase;
	}

	function isInPromptDrainLoop(): boolean {
		return phase === "PromptDrainLoop";
	}

	// --- Retry ---
	function getRetryAttempt(): number {
		return retryState.attempt;
	}

	function isRetrying(): boolean {
		return retryState.deferred !== null;
	}

	async function waitForRetry(): Promise<void> {
		if (retryState.deferred) {
			await retryState.deferred.promise;
		}
	}

	function abortRetry(): void {
		retryState.abortController?.abort();
		resolveRetry();
	}

	function resetRetryOnSuccess(): { previousAttempt: number } {
		const prev = retryState.attempt;
		retryState = { ...retryState, attempt: 0 };
		resolveRetry();
		return { previousAttempt: prev };
	}

	function incrementRetry(): number {
		// Defensive: create Deferred if not already set (in case synchronous creation was bypassed)
		if (!retryState.deferred) {
			retryState = { ...retryState, deferred: createManualDeferred() };
		}
		const attempt = retryState.attempt + 1;
		retryState = { ...retryState, attempt };
		return attempt;
	}

	function setRetryAbortController(abortController: AbortController): void {
		retryState = { ...retryState, abortController };
	}

	function clearRetryAbortController(abortController: AbortController): void {
		if (retryState.abortController === abortController) {
			retryState = { ...retryState, abortController: null };
		}
	}

	function resolveRetry(): void {
		if (retryState.deferred) {
			retryState.deferred.resolve();
			retryState = { ...initialRetryState };
		}
	}

	// --- Continuation scheduling ---
	function scheduleContinuation(agent: Agent, delayMs: number): void {
		if (lifecycleFenceDepth > 0) {
			return;
		}
		cancelContinuation();
		const generation = continuationGeneration;
		continuationTimer = setTimeout(() => {
			continuationTimer = null;
			if (generation !== continuationGeneration) {
				return;
			}
			agent.continue().catch(() => {});
		}, delayMs);
	}

	function cancelContinuation(): void {
		if (continuationTimer !== null) {
			clearTimeout(continuationTimer);
			continuationTimer = null;
		}
	}

	// --- Abort ---
	function abortAll(): void {
		continuationGeneration++;
		cancelContinuation();
		abortRetry();
	}

	// --- Dispose ---
	function dispose(): void {
		abortAll();
	}

	return {
		subscribeToAgent,
		runPromptCycle,
		runCustomMessageCycle,
		drainEventQueue,
		fenceForLifecycleSeam,
		isLifecycleFenceActive,
		getPhase,
		isInPromptDrainLoop,
		getRetryAttempt,
		isRetrying,
		waitForRetry,
		abortRetry,
		resetRetryOnSuccess,
		incrementRetry,
		setRetryAbortController,
		clearRetryAbortController,
		resolveRetry,
		scheduleContinuation,
		abortAll,
		dispose,
	};
}
