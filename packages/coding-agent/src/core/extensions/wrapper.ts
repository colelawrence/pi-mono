/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { wrapToolDefinition, wrapToolDefinitions } from "../tools/tool-definition-wrapper.js";
import type { ExtensionRunner } from "./runner.js";
import type { RegisteredTool } from "./types.js";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return wrapToolDefinition(registeredTool.definition, () => runner.createContext());
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return wrapToolDefinitions(
		registeredTools.map((registeredTool) => registeredTool.definition),
		() => runner.createContext(),
	);
}

/**
 * Wrap a tool with legacy extension interception hooks.
 *
 * AgentSession now owns tool_call/tool_result interception via agent-core hooks,
 * but a small compatibility wrapper remains for tests and direct callers that
 * need to exercise the security boundary in isolation.
 */
export function wrapToolWithExtensions<TParameters extends AgentTool["parameters"], TDetails>(
	tool: AgentTool<TParameters, TDetails>,
	runner: Pick<ExtensionRunner, "hasHandlers" | "emitToolCall" | "emitToolResult">,
): AgentTool<TParameters, TDetails> {
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			if (runner.hasHandlers("tool_call")) {
				try {
					const hookResult = await runner.emitToolCall({
						type: "tool_call",
						toolName: tool.name,
						toolCallId,
						input: params as Record<string, unknown>,
					});

					if (hookResult?.block) {
						throw new Error(hookResult.reason || `Tool execution blocked: ${tool.name}`);
					}
				} catch (error) {
					if (error instanceof Error) {
						throw error;
					}
					throw new Error(`Extension failed, blocking execution: ${String(error)}`);
				}
			}

			const result = await tool.execute(toolCallId, params, signal, onUpdate);

			if (!runner.hasHandlers("tool_result")) {
				return result;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: tool.name,
				toolCallId,
				input: params as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError: false,
			});

			if (!hookResult) {
				return result;
			}

			return {
				content: hookResult.content ?? result.content,
				details: (hookResult.details ?? result.details) as TDetails,
			};
		},
	};
}
