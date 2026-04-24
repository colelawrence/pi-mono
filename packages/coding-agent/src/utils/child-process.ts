import type { ChildProcess } from "node:child_process";

const EXIT_STDIO_GRACE_MS = 100;

export interface ChildProcessWaitResult {
	exitCode: number | null;
	finalizedBy: "close" | "exit_stdio_end" | "exit_grace_timeout";
	stdoutEnded: boolean;
	stderrEnded: boolean;
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * On Windows, daemonized descendants can inherit the child's stdout/stderr pipe
 * handles. In that case the child emits `exit`, but `close` can hang forever even
 * though the original process is already gone. We wait briefly for stdio to end,
 * then forcibly stop tracking the inherited handles.
 */
export function waitForChildProcess(child: ChildProcess): Promise<ChildProcessWaitResult> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
		};

		const finalize = (code: number | null, finalizedBy: ChildProcessWaitResult["finalizedBy"]) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve({
				exitCode: code,
				finalizedBy,
				stdoutEnded,
				stderrEnded,
			});
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode, "exit_stdio_end");
			}
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) {
				postExitTimer = setTimeout(() => finalize(code, "exit_grace_timeout"), EXIT_STDIO_GRACE_MS);
			}
		};

		const onClose = (code: number | null) => {
			finalize(code, "close");
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}
