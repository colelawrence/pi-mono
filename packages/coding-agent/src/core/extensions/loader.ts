/**
 * Extension loader - loads TypeScript extension modules using jiti.
 *
 * Uses @mariozechner/jiti fork with virtualModules support for compiled Bun binaries.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "@mariozechner/jiti";
import * as _bundledPiAgentCore from "@mariozechner/pi-agent-core";
import * as _bundledPiAi from "@mariozechner/pi-ai";
import * as _bundledPiAiOauth from "@mariozechner/pi-ai/oauth";
import type { KeyId } from "@mariozechner/pi-tui";
import * as _bundledPiTui from "@mariozechner/pi-tui";
// Static imports of packages that extensions may use.
// These MUST be static so Bun bundles them into the compiled binary.
// The virtualModules option then makes them available to extensions.
import * as _bundledTypebox from "@sinclair/typebox";
import { getAgentDir, isBunBinary } from "../../config.js";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @mariozechner/pi-coding-agent.
import * as _bundledPiCodingAgent from "../../index.js";
import { createEventBus, type EventBus } from "../event-bus.js";
import type { ExecOptions } from "../exec.js";
import { execCommand } from "../exec.js";
import { createSyntheticSourceInfo } from "../source-info.js";
import { HOST_CAPABILITIES } from "./host-capabilities.js";
import type {
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.js";

/** Modules available to extensions via virtualModules (for compiled Bun binary) */
const VIRTUAL_MODULES: Record<string, unknown> = {
	"@sinclair/typebox": _bundledTypebox,
	"@mariozechner/pi-agent-core": _bundledPiAgentCore,
	"@mariozechner/pi-tui": _bundledPiTui,
	"@mariozechner/pi-ai": _bundledPiAi,
	"@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
	"@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};

const require = createRequire(import.meta.url);

/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In Bun binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;
function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	const typeboxEntry = require.resolve("@sinclair/typebox");
	const typeboxRoot = typeboxEntry.replace(/[\\/]build[\\/]cjs[\\/]index\.js$/, "");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	_aliases = {
		"@mariozechner/pi-coding-agent": packageIndex,
		"@mariozechner/pi-agent-core": resolveWorkspaceOrImport("agent/dist/index.js", "@mariozechner/pi-agent-core"),
		"@mariozechner/pi-tui": resolveWorkspaceOrImport("tui/dist/index.js", "@mariozechner/pi-tui"),
		"@mariozechner/pi-ai": resolveWorkspaceOrImport("ai/dist/index.js", "@mariozechner/pi-ai"),
		"@mariozechner/pi-ai/oauth": resolveWorkspaceOrImport("ai/dist/oauth.js", "@mariozechner/pi-ai/oauth"),
		"@sinclair/typebox": typeboxRoot,
	};

	return _aliases;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeUnicodeSpaces(str: string): string {
	return str.replace(UNICODE_SPACES, " ");
}

function expandPath(p: string): string {
	const normalized = normalizeUnicodeSpaces(p);
	if (normalized.startsWith("~/")) {
		return path.join(os.homedir(), normalized.slice(2));
	}
	if (normalized.startsWith("~")) {
		return path.join(os.homedir(), normalized.slice(1));
	}
	return normalized;
}

function resolvePath(extPath: string, cwd: string): string {
	const expanded = expandPath(extPath);
	if (path.isAbsolute(expanded)) {
		return expanded;
	}
	return path.resolve(cwd, expanded);
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

const PI_EXTENSION_LAYER_SYMBOL = Symbol.for("pi-sdk-effect-adapter/PiExtensionLayer");

type LoadedLayerDescriptor = ExtensionFactory & {
	readonly [PI_EXTENSION_LAYER_SYMBOL]?: {
		readonly id?: string;
		readonly layer?: unknown;
	};
};

type LoadedExtensionModule =
	| { kind: "factory"; factory: ExtensionFactory }
	| { kind: "layer"; descriptor: LoadedLayerDescriptor }
	| { kind: "invalid" };

type LayeredExtensionCandidate = {
	extensionPath: string;
	resolvedPath: string;
	extension: Extension;
	api: ExtensionAPI;
	id?: string;
	layer: unknown;
};

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 */
export function createExtensionRuntime(): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		getHostCapabilities: () => HOST_CAPABILITIES,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
		},
	};

	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	const api = {
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): void {
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.js").ExtensionContext) => Promise<void> | void;
			},
		): void {
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			return runtime.getActiveTools();
		},

		getAllTools() {
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			return runtime.getCommands();
		},

		setModel(model) {
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			runtime.setThinkingLevel(level);
		},

		getHostCapabilities() {
			return runtime.getHostCapabilities();
		},

		registerProvider(name: string, config: ProviderConfig) {
			runtime.registerProvider(name, config, extension.path);
		},

		unregisterProvider(name: string) {
			runtime.unregisterProvider(name, extension.path);
		},

		events: eventBus,
	} as ExtensionAPI;

	return api;
}

async function loadExtensionModule(extensionPath: string): Promise<LoadedExtensionModule> {
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		// In Bun binary: use virtualModules for bundled packages (no filesystem resolution)
		// Also disable tryNative so jiti handles ALL imports (not just the entry point)
		// In Node.js/dev: use aliases to resolve to node_modules paths
		...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
	});

	const exported = (await jiti.import(extensionPath, { default: true })) as unknown;
	if (typeof exported !== "function") {
		return { kind: "invalid" };
	}

	const descriptor = exported as ExtensionFactory & {
		readonly [PI_EXTENSION_LAYER_SYMBOL]?: {
			readonly id?: string;
			readonly layer?: unknown;
		};
	};
	const meta = descriptor[PI_EXTENSION_LAYER_SYMBOL];
	if (meta && typeof meta === "object" && "layer" in meta) {
		return { kind: "layer", descriptor };
	}

	return { kind: "factory", factory: exported as ExtensionFactory };
}

/**
 * Create an Extension object with empty collections.
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

/**
 * Build all piExtensionLayer descriptors as one shared Effect scope.
 *
 * Loader owns the descriptor path: it never calls the descriptor function itself.
 * Instead it provides ExtensionSetup, lets the layers register into ordinary
 * Extension objects, and closes the shared scope once per generation on session_shutdown.
 */
async function buildLayeredExtensionStack(
	candidates: LayeredExtensionCandidate[],
): Promise<{ extensions: Extension[]; teardownExtension: Extension | null; errors: Array<{ path: string; error: string }> }> {
	const duplicateErrors = new Map<string, string>();
	const ids = new Map<string, string>();
	for (const candidate of candidates) {
		const id = candidate.id?.trim();
		if (!id) continue;
		const previousPath = ids.get(id);
		if (previousPath) {
			const message = `Duplicate piExtensionLayer id "${id}" detected for ${previousPath} and ${candidate.extensionPath}. Layered extension ids must be unique within one load.`;
			duplicateErrors.set(`${previousPath}:${id}`, message);
			duplicateErrors.set(`${candidate.extensionPath}:${id}`, message);
			continue;
		}
		ids.set(id, candidate.extensionPath);
	}
	if (duplicateErrors.size > 0) {
		return {
			extensions: [],
			teardownExtension: null,
			errors: Array.from(duplicateErrors.entries()).map(([key, error]) => ({
				path: key.slice(0, key.lastIndexOf(":")),
				error,
			})),
		};
	}

	let rootScope: any | null = null;
	let closePromise: Promise<void> | null = null;
	let effectApi: { Effect: any; Exit: any; Layer: any; Scope: any } | null = null;
	try {
		const extensionJiti = createJiti(candidates[0]!.resolvedPath, {
			moduleCache: false,
			...(isBunBinary ? { virtualModules: VIRTUAL_MODULES, tryNative: false } : { alias: getAliases() }),
		});
		const [{ Effect, Exit, Layer, Scope }, adapter] = await Promise.all([
			extensionJiti.import("effect"),
			extensionJiti.import("@phosphor/pi-sdk-effect-adapter"),
		]);
		effectApi = { Effect, Exit, Layer, Scope };
		const { ExtensionSetup, onEffect, registerCommandEffect, registerToolEffect } = adapter as Record<string, any>;
		if (
			typeof onEffect !== "function" ||
			typeof registerCommandEffect !== "function" ||
			typeof registerToolEffect !== "function" ||
			!ExtensionSetup
		) {
			throw new Error(
				"Layered extensions require the workspace @phosphor/pi-sdk-effect-adapter exports ExtensionSetup, onEffect, registerCommandEffect, and registerToolEffect. The patched pi runtime is missing or using an outdated adapter.",
			);
		}

		rootScope = await Effect.runPromise(Scope.make());
		const closeRootScope = (): Promise<void> => {
			if (!closePromise) {
				closePromise = Effect.runPromise(Scope.close(rootScope, Exit.void));
			}
			return closePromise;
		};

		const layers = candidates.map((candidate) => {
			const setupService = {
				pi: candidate.api,
				on: (event: string, handler: any, options?: any) =>
					Effect.sync(() => {
						onEffect(candidate.api, event, handler, options);
					}),
				command: (name: string, options: any) =>
					Effect.sync(() => {
						registerCommandEffect(candidate.api, name, options);
					}),
				tool: (tool: any) =>
					Effect.sync(() => {
						registerToolEffect(candidate.api, tool);
					}),
			};
			return (candidate.layer as any).pipe(Layer.provide(Layer.succeed(ExtensionSetup, setupService)));
		});
		const mergedLayer = layers.length === 1 ? layers[0] : Layer.mergeAll(...(layers as [any, ...Array<any>]));
		await Effect.runPromise(Layer.buildWithScope(rootScope)(mergedLayer));

		const teardownExtension = createExtension("<layered-extension-stack>", "<layered-extension-stack>");
		// Keep scope teardown under loader ownership. Append this synthetic extension last
		// and rely on ExtensionRunner.emit iterating extensions in insertion order so
		// layered session_shutdown handlers run before the shared scope closes.
		teardownExtension.handlers.set("session_shutdown", [() => closeRootScope()]);

		return {
			extensions: candidates.map((candidate) => candidate.extension),
			teardownExtension,
			errors: [],
		};
	} catch (err) {
		if (rootScope && effectApi) {
			const closeRootScope = (): Promise<void> => {
				if (!closePromise) {
					closePromise = effectApi.Effect.runPromise(effectApi.Scope.close(rootScope, effectApi.Exit.void));
				}
				return closePromise;
			};
			await closeRootScope();
		}
		const message = err instanceof Error ? err.message : String(err);
		return {
			extensions: [],
			teardownExtension: null,
			errors: candidates.map((candidate) => ({
				path: candidate.extensionPath,
				error: `Failed to initialize layered extension stack${candidate.id ? ` (${candidate.id})` : ""}: ${message}`,
			})),
		};
	}
}

async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<{ extension: Extension | null; layeredCandidate: LayeredExtensionCandidate | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd);

	try {
		const loaded = await loadExtensionModule(resolvedPath);
		if (loaded.kind === "invalid") {
			return {
				extension: null,
				layeredCandidate: null,
				error: `Extension does not export a valid factory or piExtensionLayer descriptor: ${extensionPath}`,
			};
		}

		const extension = createExtension(extensionPath, resolvedPath);
		const api = createExtensionAPI(extension, runtime, cwd, eventBus);
		if (loaded.kind === "layer") {
			const meta = loaded.descriptor[PI_EXTENSION_LAYER_SYMBOL];
			if (!meta?.layer || typeof (meta.layer as { pipe?: unknown }).pipe !== "function") {
				return {
					extension: null,
					layeredCandidate: null,
					error: `Invalid piExtensionLayer descriptor: ${extensionPath} is missing a usable layer export.`,
				};
			}
			return {
				extension: null,
				layeredCandidate: {
					extensionPath,
					resolvedPath,
					extension,
					api,
					id: typeof meta.id === "string" ? meta.id : undefined,
					layer: meta.layer,
				},
				error: null,
			};
		}

		await loaded.factory(api);

		return { extension, layeredCandidate: null, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, layeredCandidate: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const extension = createExtension(extensionPath, extensionPath);
	const api = createExtensionAPI(extension, runtime, cwd, eventBus);
	await factory(api);
	return extension;
}

/**
 * Load extensions from paths.
 */
export async function loadExtensions(paths: string[], cwd: string, eventBus?: EventBus): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? createEventBus();
	const runtime = createExtensionRuntime();

	const layeredCandidates: LayeredExtensionCandidate[] = [];

	for (const extPath of paths) {
		const { extension, layeredCandidate, error } = await loadExtension(extPath, cwd, resolvedEventBus, runtime);

		if (error) {
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
		if (layeredCandidate) {
			layeredCandidates.push(layeredCandidate);
		}
	}

	if (layeredCandidates.length > 0) {
		const layeredStack = await buildLayeredExtensionStack(layeredCandidates);
		extensions.push(...layeredStack.extensions);
		if (layeredStack.teardownExtension) {
			extensions.push(layeredStack.teardownExtension);
		}
		errors.push(...layeredStack.errors);
	}

	return {
		extensions,
		errors,
		runtime,
	};
}

interface PiManifest {
	extensions?: string[];
	themes?: string[];
	skills?: string[];
	prompts?: string[];
}

function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const content = fs.readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content);
		if (pkg.pi && typeof pkg.pi === "object") {
			return pkg.pi as PiManifest;
		}
		return null;
	} catch {
		return null;
	}
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json with "pi.extensions" field -> returns declared paths
 * 2. index.ts or index.js -> returns the index file
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
	// Check for package.json with "pi" field first
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` with "pi" field → load what it declares
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const allPaths: string[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. Project-local extensions: cwd/.pi/extensions/
	const localExtDir = path.join(cwd, ".pi", "extensions");
	addPaths(discoverExtensionsInDir(localExtDir));

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(agentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, cwd);
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for package.json with pi manifest or index.ts
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		addPaths([resolved]);
	}

	return loadExtensions(allPaths, cwd, eventBus);
}
