import { describe, expect, it } from "vitest";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.js";

describe("bash tool telemetry details", () => {
	it("attaches execution telemetry to successful results", async () => {
		const operations: BashOperations = {
			exec: async (_command, cwd, { onData }) => {
				onData(Buffer.from("stdout"));
				onData(Buffer.from("stderr"));
				return {
					exitCode: 0,
					metadata: {
						shellPath: "/bin/bash",
						shellArgs: ["-c"],
						cwd,
						stdoutBytes: 6,
						stderrBytes: 6,
						outputBytes: 12,
						stdoutEnded: true,
						stderrEnded: true,
						finalizedBy: "close",
					},
				};
			},
		};

		const tool = createBashToolDefinition(process.cwd(), {
			operations,
			commandPrefix: "set -e",
		});

		const result = await tool.execute(
			"tool-bash-telemetry-ok",
			{ command: "echo hello", timeout: 15 },
			undefined,
			undefined,
			{} as never,
		);

		expect(result.details?.telemetry).toEqual(
			expect.objectContaining({
				shellPath: "/bin/bash",
				shellArgs: ["-c"],
				commandPrefixPresent: true,
				timeoutSeconds: 15,
				stdoutBytes: 6,
				stderrBytes: 6,
				outputBytes: 12,
				finalizedBy: "close",
				stdoutEnded: true,
				stderrEnded: true,
			}),
		);
	});

	it("throws structured errors that preserve telemetry details", async () => {
		const operations: BashOperations = {
			exec: async (_command, cwd) => ({
				exitCode: 1,
				metadata: {
					shellPath: "/bin/bash",
					shellArgs: ["-c"],
					cwd,
					stdoutBytes: 0,
					stderrBytes: 0,
					outputBytes: 0,
					stdoutEnded: true,
					stderrEnded: true,
					finalizedBy: "exit_grace_timeout",
				},
			}),
		};

		const tool = createBashToolDefinition(process.cwd(), { operations });

		await expect(
			tool.execute("tool-bash-telemetry-error", { command: "false", timeout: 9 }, undefined, undefined, {} as never),
		).rejects.toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("Command exited with code 1") }],
			details: {
				telemetry: expect.objectContaining({
					exitCode: 1,
					nonzeroWithoutOutput: true,
					timeoutSeconds: 9,
					finalizedBy: "exit_grace_timeout",
					outputBytes: 0,
				}),
			},
		});
	});
});
