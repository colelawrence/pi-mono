/**
 * Security canary tests for the tool_call extension event boundary.
 *
 * The tool_call event is the security gate — extensions like dangerous-commands
 * register handlers that can block tool execution by throwing or returning {block: true}.
 * These tests verify that the security boundary works correctly:
 * 1. Throwing handlers prevent tool execution
 * 2. Blocking handlers ({block: true}) prevent tool execution
 * 3. Non-blocking handlers allow tool execution to proceed
 * 4. Multiple handlers are called in order (first block wins)
 *
 * CRITICAL: These are regression tests for the security boundary.
 * If any of these tests fail after a refactor, the refactor has broken security.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import type { ExtensionRunner, ToolCallEventResult } from "../src/core/extensions/index.ts";
import { wrapToolWithExtensions } from "../src/core/extensions/wrapper.ts";

// Minimal mock for ExtensionRunner — only the methods wrapToolWithExtensions uses
function createMockRunner(
	handlers: Array<(event: any, ctx: any) => Promise<ToolCallEventResult | undefined>>,
): Pick<ExtensionRunner, "hasHandlers" | "emitToolCall" | "emitToolResult"> {
	return {
		hasHandlers: (type: string) => type === "tool_call" && handlers.length > 0,
		emitToolCall: async (event: any) => {
			let result: ToolCallEventResult | undefined;
			for (const handler of handlers) {
				const handlerResult = await handler(event, {});
				if (handlerResult) {
					result = handlerResult;
					if (result.block) return result;
				}
			}
			return result;
		},
		emitToolResult: async () => undefined,
	} as any;
}

function createMockTool(name: string): AgentTool & { executeCalled: boolean } {
	const tool = {
		name,
		label: name,
		description: `Test tool: ${name}`,
		parameters: Type.Object({}),
		executeCalled: false,
		execute: async () => {
			tool.executeCalled = true;
			return { content: [{ type: "text" as const, text: "executed" }], details: {} };
		},
	};
	return tool;
}

describe("tool_call security boundary", () => {
	it("throwing handler prevents tool execution", async () => {
		const tool = createMockTool("test_tool");
		const runner = createMockRunner([
			async () => {
				throw new Error("BLOCKED by security extension");
			},
		]);

		const wrapped = wrapToolWithExtensions(tool, runner);

		await expect(wrapped.execute("call-1", {}, undefined)).rejects.toThrow("BLOCKED by security extension");
		expect(tool.executeCalled).toBe(false);
	});

	it("blocking handler ({block: true}) prevents tool execution", async () => {
		const tool = createMockTool("test_tool");
		const runner = createMockRunner([async () => ({ block: true, reason: "Dangerous command detected" })]);

		const wrapped = wrapToolWithExtensions(tool, runner);

		await expect(wrapped.execute("call-1", {}, undefined)).rejects.toThrow("Dangerous command detected");
		expect(tool.executeCalled).toBe(false);
	});

	it("non-blocking handler allows tool execution", async () => {
		const tool = createMockTool("test_tool");
		const runner = createMockRunner([async () => undefined]);

		const wrapped = wrapToolWithExtensions(tool, runner);

		const result = await wrapped.execute("call-1", {}, undefined);
		expect(tool.executeCalled).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "executed" }]);
	});

	it("first blocking handler wins (later handlers not called)", async () => {
		const handlersCalled: number[] = [];
		const tool = createMockTool("test_tool");
		const runner = createMockRunner([
			async () => {
				handlersCalled.push(1);
				return { block: true, reason: "First blocker" };
			},
			async () => {
				handlersCalled.push(2);
				return { block: true, reason: "Second blocker" };
			},
		]);

		const wrapped = wrapToolWithExtensions(tool, runner);

		await expect(wrapped.execute("call-1", {}, undefined)).rejects.toThrow("First blocker");
		expect(tool.executeCalled).toBe(false);
		expect(handlersCalled).toEqual([1]); // Second handler was never called
	});

	it("non-Error throws are wrapped as Error", async () => {
		const tool = createMockTool("test_tool");
		const runner = createMockRunner([
			async () => {
				throw "string error"; // Non-Error throw
			},
		]);

		const wrapped = wrapToolWithExtensions(tool, runner);

		await expect(wrapped.execute("call-1", {}, undefined)).rejects.toThrow(
			"Extension failed, blocking execution: string error",
		);
		expect(tool.executeCalled).toBe(false);
	});

	it("handler receives correct tool name and input", async () => {
		let receivedEvent: any;
		const tool = createMockTool("my_special_tool");
		const runner = createMockRunner([
			async (event: any) => {
				receivedEvent = event;
				return undefined; // Allow execution
			},
		]);

		const wrapped = wrapToolWithExtensions(tool, runner);
		await wrapped.execute("call-42", { path: "/etc/passwd" }, undefined);

		expect(receivedEvent).toEqual({
			type: "tool_call",
			toolName: "my_special_tool",
			toolCallId: "call-42",
			input: { path: "/etc/passwd" },
		});
	});

	it("tool execution without any handlers proceeds normally", async () => {
		const tool = createMockTool("unguarded_tool");
		const runner = createMockRunner([]); // No handlers

		const wrapped = wrapToolWithExtensions(tool, runner);

		const result = await wrapped.execute("call-1", {}, undefined);
		expect(tool.executeCalled).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "executed" }]);
	});
});
