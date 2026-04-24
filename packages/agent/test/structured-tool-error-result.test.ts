import { type AssistantMessage, EventStream, type Message, type Model, type UserMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.js";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.js";

class MockAssistantStream extends EventStream<any, AssistantMessage> {
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

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

describe("structured tool execution errors", () => {
	it("preserves thrown tool details in tool results", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const tool: AgentTool<typeof toolSchema, { diagnostic: string }> = {
			name: "explode",
			label: "Explode",
			description: "Explodes with structured details",
			parameters: toolSchema,
			async execute() {
				const error = new Error("tool exploded") as Error & {
					content: Array<{ type: "text"; text: string }>;
					details: { diagnostic: string };
				};
				error.content = [{ type: "text", text: "tool exploded" }];
				error.details = { diagnostic: "preserved" };
				throw error;
			},
		};

		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
		};

		let callIndex = 0;
		const stream = agentLoop(
			[createUserMessage("run explode")],
			{ systemPrompt: "", messages: [], tools: [tool] },
			config,
			undefined,
			() => {
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callIndex === 0) {
						mockStream.push({
							type: "done",
							reason: "toolUse",
							message: createAssistantMessage(
								[{ type: "toolCall", id: "explode-1", name: "explode", arguments: { value: "boom" } }],
								"toolUse",
							),
						});
					} else {
						mockStream.push({
							type: "done",
							reason: "stop",
							message: createAssistantMessage([{ type: "text", text: "done" }]),
						});
					}
					callIndex += 1;
				});
				return mockStream;
			},
		);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}

		const toolEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		);
		expect(toolEnd).toBeDefined();
		expect(toolEnd?.isError).toBe(true);
		expect(toolEnd?.result.details).toEqual({ diagnostic: "preserved" });

		const toolResultMessage = events.find(
			(event): event is Extract<AgentEvent, { type: "message_end" }> =>
				event.type === "message_end" && event.message.role === "toolResult",
		);
		expect(toolResultMessage).toBeDefined();
		if (!toolResultMessage || toolResultMessage.message.role !== "toolResult") {
			throw new Error("Expected a toolResult message");
		}
		expect(toolResultMessage.message.details).toEqual({ diagnostic: "preserved" });
		expect(toolResultMessage.message.isError).toBe(true);
	});
});
