import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { HOST_CAPABILITIES } from "../src/core/extensions/host-capabilities.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionContextActions } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("host capabilities", () => {
	it("exposes host capabilities through runtime and extension context", () => {
		const tempDir = "/tmp/pi-host-capabilities";
		const runtime = createExtensionRuntime();
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage);
		const runner = new ExtensionRunner([], runtime, tempDir, sessionManager, modelRegistry);

		const extensionActions: ExtensionActions = {
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setSessionName: () => {},
			getSessionName: () => undefined,
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: () => {},
			refreshTools: () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => "off",
			setThinkingLevel: () => {},
			getHostCapabilities: () => HOST_CAPABILITIES,
		};

		const extensionContextActions: ExtensionContextActions = {
			getModel: () => undefined,
			isIdle: () => true,
			getSignal: () => undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
		};

		runner.bindCore(extensionActions, extensionContextActions);

		expect(runtime.getHostCapabilities()).toEqual(HOST_CAPABILITIES);
		expect(runner.createContext().hostCapabilities).toEqual(HOST_CAPABILITIES);
	});
});
