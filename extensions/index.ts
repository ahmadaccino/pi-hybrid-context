/**
 * Hybrid Context Extension for pi
 *
 * Starts on a standard context-window Anthropic model (200k tokens) for speed
 * and cost savings, then automatically switches to the 1M context-window variant
 * when context usage reaches a configurable threshold (default: 90%).
 *
 * This is a one-way escalation per session — once switched to 1M, it stays there.
 *
 * Supported model pairs:
 *
 *   Anthropic direct API:
 *     claude-sonnet-4-5  →  claude-sonnet-4-6
 *     claude-opus-4-5    →  claude-opus-4-6
 *
 *   AWS Bedrock (all region prefixes):
 *     anthropic.claude-sonnet-4-5-*  →  anthropic.claude-sonnet-4-6
 *     anthropic.claude-opus-4-5-*    →  anthropic.claude-opus-4-6-v1
 *     us.anthropic.claude-sonnet-4-5-*  →  us.anthropic.claude-sonnet-4-6
 *     us.anthropic.claude-opus-4-5-*    →  us.anthropic.claude-opus-4-6-v1
 *     eu.anthropic.claude-sonnet-4-5-*  →  eu.anthropic.claude-sonnet-4-6
 *     eu.anthropic.claude-opus-4-5-*    →  eu.anthropic.claude-opus-4-6-v1
 *     global.anthropic.claude-sonnet-4-5-*  →  global.anthropic.claude-sonnet-4-6
 *     global.anthropic.claude-opus-4-5-*    →  global.anthropic.claude-opus-4-6-v1
 *
 * Usage:
 *   pi install git:github.com/AhmadMayo/pi-hybrid-context
 *   pi -e ./path/to/pi-hybrid-context
 *
 * The extension activates automatically when you select a supported model.
 * Use /hybrid-context to see current status or /hybrid-threshold to change the threshold.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Model pair configuration
// ---------------------------------------------------------------------------

interface ModelPair {
	/** Pattern to match the base model ID (supports startsWith matching) */
	basePattern: string;
	/** Exact model ID of the 1M context variant */
	targetId: string;
	/** Provider name */
	provider: string;
}

/**
 * Build the full model pair table.
 * For each family (sonnet-4-5 → sonnet-4-6, opus-4-5 → opus-4-6) we generate
 * entries for direct Anthropic API and all Bedrock region prefixes.
 */
function buildModelPairs(): ModelPair[] {
	const pairs: ModelPair[] = [];

	// --- Anthropic direct API ---
	const anthropicFamilies: Array<{ base: string; target: string }> = [
		// Aliases (latest pointers)
		{ base: "claude-sonnet-4-5", target: "claude-sonnet-4-6" },
		{ base: "claude-opus-4-5", target: "claude-opus-4-6" },
		// Dated versions
		{ base: "claude-sonnet-4-5-20250929", target: "claude-sonnet-4-6" },
		{ base: "claude-opus-4-5-20251101", target: "claude-opus-4-6" },
		// Older models that also have 200k context
		{ base: "claude-sonnet-4-20250514", target: "claude-sonnet-4-6" },
		{ base: "claude-opus-4-20250514", target: "claude-opus-4-6" },
		{ base: "claude-opus-4-1-20250805", target: "claude-opus-4-6" },
		{ base: "claude-sonnet-4-0", target: "claude-sonnet-4-6" },
		{ base: "claude-opus-4-0", target: "claude-opus-4-6" },
		{ base: "claude-opus-4-1", target: "claude-opus-4-6" },
	];

	for (const { base, target } of anthropicFamilies) {
		pairs.push({ basePattern: base, targetId: target, provider: "anthropic" });
	}

	// --- AWS Bedrock ---
	const bedrockPrefixes = ["", "us.", "eu.", "global."];

	const bedrockFamilies: Array<{ base: string; target: string }> = [
		// Sonnet 4.5 → Sonnet 4.6
		{ base: "anthropic.claude-sonnet-4-5-20250929-v1:0", target: "anthropic.claude-sonnet-4-6" },
		// Opus 4.5 → Opus 4.6
		{ base: "anthropic.claude-opus-4-5-20251101-v1:0", target: "anthropic.claude-opus-4-6-v1" },
		// Sonnet 4 → Sonnet 4.6
		{ base: "anthropic.claude-sonnet-4-20250514-v1:0", target: "anthropic.claude-sonnet-4-6" },
		// Opus 4 → Opus 4.6
		{ base: "anthropic.claude-opus-4-20250514-v1:0", target: "anthropic.claude-opus-4-6-v1" },
		// Opus 4.1 → Opus 4.6
		{ base: "anthropic.claude-opus-4-1-20250805-v1:0", target: "anthropic.claude-opus-4-6-v1" },
	];

	for (const prefix of bedrockPrefixes) {
		for (const { base, target } of bedrockFamilies) {
			pairs.push({
				basePattern: `${prefix}${base}`,
				targetId: `${prefix}${target}`,
				provider: "amazon-bedrock",
			});
		}
	}

	// --- OpenRouter ---
	const openrouterFamilies: Array<{ base: string; target: string }> = [
		{ base: "anthropic/claude-sonnet-4.5", target: "anthropic/claude-sonnet-4.6" },
		{ base: "anthropic/claude-opus-4.5", target: "anthropic/claude-opus-4.6" },
		{ base: "anthropic/claude-sonnet-4", target: "anthropic/claude-sonnet-4.6" },
		{ base: "anthropic/claude-opus-4", target: "anthropic/claude-opus-4.6" },
		{ base: "anthropic/claude-opus-4.1", target: "anthropic/claude-opus-4.6" },
	];

	for (const { base, target } of openrouterFamilies) {
		pairs.push({ basePattern: base, targetId: target, provider: "openrouter" });
	}

	return pairs;
}

const MODEL_PAIRS = buildModelPairs();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface HybridState {
	/** Whether we've already switched to the 1M model this session */
	switched: boolean;
	/** The base model ID we started on (before any switch) */
	baseModelId: string | undefined;
	/** The base model's provider */
	baseProvider: string | undefined;
	/** The 1M target model ID */
	targetModelId: string | undefined;
	/** The base model's context window size */
	baseContextWindow: number | undefined;
	/** Switch threshold as a fraction (0.0 – 1.0) */
	threshold: number;
}

const CUSTOM_TYPE = "hybrid-context-state";
const DEFAULT_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the 1M target model ID for a given base model.
 */
function findTargetModel(
	modelId: string,
	provider: string,
): { targetId: string; provider: string } | undefined {
	for (const pair of MODEL_PAIRS) {
		if (pair.provider === provider && modelId === pair.basePattern) {
			return { targetId: pair.targetId, provider: pair.provider };
		}
	}
	return undefined;
}

/**
 * Check if a model is already a 1M context model (i.e., it's a target, not a base).
 */
function isAlready1MModel(modelId: string): boolean {
	return MODEL_PAIRS.some((pair) => pair.targetId === modelId);
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
	return `${tokens}`;
}

function formatPercent(ratio: number): string {
	return `${Math.round(ratio * 100)}%`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let state: HybridState = {
		switched: false,
		baseModelId: undefined,
		baseProvider: undefined,
		targetModelId: undefined,
		baseContextWindow: undefined,
		threshold: DEFAULT_THRESHOLD,
	};

	// -----------------------------------------------------------------------
	// Restore state from session
	// -----------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		// Reset state
		state = {
			switched: false,
			baseModelId: undefined,
			baseProvider: undefined,
			targetModelId: undefined,
			baseContextWindow: undefined,
			threshold: DEFAULT_THRESHOLD,
		};

		// Restore from session entries
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as Partial<HybridState>;
				if (data.switched !== undefined) state.switched = data.switched;
				if (data.baseModelId !== undefined) state.baseModelId = data.baseModelId;
				if (data.baseProvider !== undefined) state.baseProvider = data.baseProvider;
				if (data.targetModelId !== undefined) state.targetModelId = data.targetModelId;
				if (data.baseContextWindow !== undefined) state.baseContextWindow = data.baseContextWindow;
				if (data.threshold !== undefined) state.threshold = data.threshold;
			}
		}

		updateStatus(ctx);
	});

	// -----------------------------------------------------------------------
	// Track model changes
	// -----------------------------------------------------------------------
	pi.on("model_select", async (event, ctx) => {
		const { model, source } = event;

		// If restoring a session and we already switched, don't re-evaluate
		if (source === "restore" && state.switched) {
			updateStatus(ctx);
			return;
		}

		// If user manually selects a model, re-evaluate the pair
		// (unless they selected the 1M model we already switched to)
		if (state.switched && model.id === state.targetModelId) {
			updateStatus(ctx);
			return;
		}

		// Reset switch state when user selects a new base model
		state.switched = false;

		// Check if this model has a 1M target
		const target = findTargetModel(model.id, model.provider);

		if (target) {
			state.baseModelId = model.id;
			state.baseProvider = model.provider;
			state.targetModelId = target.targetId;
			state.baseContextWindow = model.contextWindow;

			if (source !== "restore") {
				ctx.ui.notify(
					`🔀 Hybrid context active: will switch to 1M at ${formatPercent(state.threshold)}`,
					"info",
				);
			}
		} else if (isAlready1MModel(model.id)) {
			// User selected a 1M model directly — no hybrid needed
			state.baseModelId = undefined;
			state.baseProvider = undefined;
			state.targetModelId = undefined;
			state.baseContextWindow = undefined;
		} else {
			// Not a supported model
			state.baseModelId = undefined;
			state.baseProvider = undefined;
			state.targetModelId = undefined;
			state.baseContextWindow = undefined;
		}

		updateStatus(ctx);
	});

	// -----------------------------------------------------------------------
	// Monitor context usage after each turn
	// -----------------------------------------------------------------------
	pi.on("turn_end", async (_event, ctx) => {
		// Nothing to do if already switched or no target configured
		if (state.switched || !state.targetModelId || !state.baseContextWindow) {
			updateStatus(ctx);
			return;
		}

		const usage = ctx.getContextUsage();
		if (!usage) return;

		const ratio = usage.tokens / state.baseContextWindow;

		// Update status bar with current usage
		updateStatus(ctx, usage.tokens);

		// Check threshold
		if (ratio >= state.threshold) {
			await performSwitch(ctx, usage.tokens);
		}
	});

	// -----------------------------------------------------------------------
	// Switch to 1M model
	// -----------------------------------------------------------------------
	async function performSwitch(
		ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
		currentTokens: number,
	) {
		if (!state.targetModelId || !state.baseProvider) return;

		const targetModel = ctx.modelRegistry.find(state.baseProvider, state.targetModelId);
		if (!targetModel) {
			ctx.ui.notify(
				`⚠️ Hybrid context: 1M model "${state.targetModelId}" not found. Continuing on current model.`,
				"warning",
			);
			return;
		}

		const success = await pi.setModel(targetModel);
		if (!success) {
			ctx.ui.notify(
				`⚠️ Hybrid context: no API key for 1M model "${state.targetModelId}". Continuing on current model.`,
				"warning",
			);
			return;
		}

		state.switched = true;

		// Persist state
		pi.appendEntry(CUSTOM_TYPE, { ...state });

		const fromTokens = formatTokens(currentTokens);
		const fromWindow = formatTokens(state.baseContextWindow!);
		ctx.ui.notify(
			`🔀 Hybrid context: switched to 1M model (was ${fromTokens}/${fromWindow})`,
			"info",
		);

		updateStatus(ctx, currentTokens);
	}

	// -----------------------------------------------------------------------
	// Status bar
	// -----------------------------------------------------------------------
	function updateStatus(
		ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
		currentTokens?: number,
	) {
		if (!state.baseModelId || !state.baseContextWindow) {
			ctx.ui.setStatus("hybrid-ctx", undefined);
			return;
		}

		if (state.switched) {
			ctx.ui.setStatus("hybrid-ctx", "🔀 Hybrid: 1M active");
			return;
		}

		if (currentTokens !== undefined) {
			const ratio = currentTokens / state.baseContextWindow;
			const pct = formatPercent(ratio);
			const threshold = formatPercent(state.threshold);
			const window = formatTokens(state.baseContextWindow);
			ctx.ui.setStatus("hybrid-ctx", `🔀 Hybrid: ${pct} of ${window} (→1M at ${threshold})`);
		} else {
			const window = formatTokens(state.baseContextWindow);
			const threshold = formatPercent(state.threshold);
			ctx.ui.setStatus("hybrid-ctx", `🔀 Hybrid: ${window} → 1M at ${threshold}`);
		}
	}

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------
	pi.registerCommand("hybrid-context", {
		description: "Show hybrid context status",
		handler: async (_args, ctx) => {
			if (!state.baseModelId) {
				ctx.ui.notify(
					"Hybrid context is not active. Select a supported Anthropic model (e.g., claude-sonnet-4-5).",
					"info",
				);
				return;
			}

			const usage = ctx.getContextUsage();
			const tokens = usage?.tokens ?? 0;
			const ratio = state.baseContextWindow ? tokens / state.baseContextWindow : 0;

			let msg = `🔀 Hybrid Context Status\n`;
			msg += `  Base model:     ${state.baseModelId}\n`;
			msg += `  1M target:      ${state.targetModelId}\n`;
			msg += `  Context window: ${formatTokens(state.baseContextWindow ?? 0)}\n`;
			msg += `  Current usage:  ${formatTokens(tokens)} (${formatPercent(ratio)})\n`;
			msg += `  Threshold:      ${formatPercent(state.threshold)}\n`;
			msg += `  Switched:       ${state.switched ? "Yes ✓" : "No — waiting"}`;

			ctx.ui.notify(msg, "info");
		},
	});

	pi.registerCommand("hybrid-threshold", {
		description: "Set hybrid context switch threshold (e.g., /hybrid-threshold 85)",
		handler: async (args, ctx) => {
			const value = parseInt(args.trim(), 10);
			if (isNaN(value) || value < 1 || value > 99) {
				ctx.ui.notify("Usage: /hybrid-threshold <1-99> (percentage)", "error");
				return;
			}

			state.threshold = value / 100;
			pi.appendEntry(CUSTOM_TYPE, { ...state });

			ctx.ui.notify(
				`🔀 Hybrid context threshold set to ${formatPercent(state.threshold)}`,
				"info",
			);
			updateStatus(ctx);
		},
	});
}
