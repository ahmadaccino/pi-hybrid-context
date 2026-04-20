/**
 * Hybrid Context Extension for pi
 *
 * Gives you the best of both worlds: start on a fast, cheap 200k context model,
 * then auto-switch to the 1M context variant when you actually need the space.
 *
 * Works both ways:
 *   - Select a 200k model  →  monitors usage, switches to 1M at threshold
 *   - Select a 1M model    →  immediately drops to 200k base, switches back at threshold
 *
 * This is a one-way escalation per session — once switched to 1M, it stays there.
 *
 * Supported model families:
 *
 *   Anthropic direct API:
 *     claude-sonnet-4-5  ↔  claude-sonnet-4-6
 *     claude-opus-4-5    ↔  claude-opus-4-6
 *
 *   AWS Bedrock (all region prefixes: bare, us., eu., global.):
 *     anthropic.claude-sonnet-4-5-*  ↔  anthropic.claude-sonnet-4-6
 *     anthropic.claude-opus-4-5-*    ↔  anthropic.claude-opus-4-6-v1
 *
 *   OpenRouter:
 *     anthropic/claude-sonnet-4.5  ↔  anthropic/claude-sonnet-4.6
 *     anthropic/claude-opus-4.5    ↔  anthropic/claude-opus-4.6
 *
 * Usage:
 *   pi install git:github.com/ahmadaccino/pi-hybrid-context
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
	/** The smaller context-window model ID (e.g. 200k) */
	baseId: string;
	/** The 1M context-window model ID */
	largeId: string;
	/** Provider name */
	provider: string;
}

/**
 * Build the full model pair table.
 * Each entry maps a base (200k) model ↔ large (1M) model within the same provider.
 */
function buildModelPairs(): ModelPair[] {
	const pairs: ModelPair[] = [];

	// --- Anthropic direct API ---
	const anthropicPairs: Array<{ base: string; large: string }> = [
		// Aliases (latest pointers)
		{ base: "claude-sonnet-4-5", large: "claude-sonnet-4-6" },
		{ base: "claude-opus-4-5", large: "claude-opus-4-6" },
		// Dated versions
		{ base: "claude-sonnet-4-5-20250929", large: "claude-sonnet-4-6" },
		{ base: "claude-opus-4-5-20251101", large: "claude-opus-4-6" },
		// Older 200k models → latest 1M
		{ base: "claude-sonnet-4-20250514", large: "claude-sonnet-4-6" },
		{ base: "claude-opus-4-20250514", large: "claude-opus-4-6" },
		{ base: "claude-opus-4-1-20250805", large: "claude-opus-4-6" },
		{ base: "claude-sonnet-4-0", large: "claude-sonnet-4-6" },
		{ base: "claude-opus-4-0", large: "claude-opus-4-6" },
		{ base: "claude-opus-4-1", large: "claude-opus-4-6" },
	];

	for (const { base, large } of anthropicPairs) {
		pairs.push({ baseId: base, largeId: large, provider: "anthropic" });
	}

	// --- AWS Bedrock ---
	const bedrockPrefixes = ["", "us.", "eu.", "global."];

	const bedrockPairs: Array<{ base: string; large: string }> = [
		{ base: "anthropic.claude-sonnet-4-5-20250929-v1:0", large: "anthropic.claude-sonnet-4-6" },
		{ base: "anthropic.claude-opus-4-5-20251101-v1:0", large: "anthropic.claude-opus-4-6-v1" },
		{ base: "anthropic.claude-sonnet-4-20250514-v1:0", large: "anthropic.claude-sonnet-4-6" },
		{ base: "anthropic.claude-opus-4-20250514-v1:0", large: "anthropic.claude-opus-4-6-v1" },
		{ base: "anthropic.claude-opus-4-1-20250805-v1:0", large: "anthropic.claude-opus-4-6-v1" },
	];

	for (const prefix of bedrockPrefixes) {
		for (const { base, large } of bedrockPairs) {
			pairs.push({
				baseId: `${prefix}${base}`,
				largeId: `${prefix}${large}`,
				provider: "amazon-bedrock",
			});
		}
	}

	// --- OpenRouter ---
	const openrouterPairs: Array<{ base: string; large: string }> = [
		{ base: "anthropic/claude-sonnet-4.5", large: "anthropic/claude-sonnet-4.6" },
		{ base: "anthropic/claude-opus-4.5", large: "anthropic/claude-opus-4.6" },
		{ base: "anthropic/claude-sonnet-4", large: "anthropic/claude-sonnet-4.6" },
		{ base: "anthropic/claude-opus-4", large: "anthropic/claude-opus-4.6" },
		{ base: "anthropic/claude-opus-4.1", large: "anthropic/claude-opus-4.6" },
	];

	for (const { base, large } of openrouterPairs) {
		pairs.push({ baseId: base, largeId: large, provider: "openrouter" });
	}

	return pairs;
}

const MODEL_PAIRS = buildModelPairs();

/**
 * Look up a model pair given any model ID (base or large) and provider.
 * Returns the pair if found, or undefined.
 */
function findPair(
	modelId: string,
	provider: string,
): { pair: ModelPair; selectedSide: "base" | "large" } | undefined {
	for (const pair of MODEL_PAIRS) {
		if (pair.provider !== provider) continue;
		if (modelId === pair.baseId) return { pair, selectedSide: "base" };
		if (modelId === pair.largeId) return { pair, selectedSide: "large" };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface HybridState {
	/** Whether we've already escalated to the 1M model this session */
	switched: boolean;
	/** The 200k base model ID we run on until threshold */
	baseModelId: string | undefined;
	/** The 1M model ID we escalate to */
	largeModelId: string | undefined;
	/** Provider for both models */
	provider: string | undefined;
	/** Context window of the base model (the ceiling we monitor) */
	baseContextWindow: number | undefined;
	/** Switch threshold as a fraction (0.0 – 1.0) */
	threshold: number;
	/** The model ID the user originally selected (before any swap) */
	userSelectedId: string | undefined;
}

const CUSTOM_TYPE = "hybrid-context-state";
const DEFAULT_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
		largeModelId: undefined,
		provider: undefined,
		baseContextWindow: undefined,
		threshold: DEFAULT_THRESHOLD,
		userSelectedId: undefined,
	};

	/** Flag to suppress re-entrance when we call pi.setModel() ourselves. */
	let selfSwitch = false;

	// -----------------------------------------------------------------------
	// Restore state from session
	// -----------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		state = {
			switched: false,
			baseModelId: undefined,
			largeModelId: undefined,
			provider: undefined,
			baseContextWindow: undefined,
			threshold: DEFAULT_THRESHOLD,
			userSelectedId: undefined,
		};

		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as Partial<HybridState>;
				if (data.switched !== undefined) state.switched = data.switched;
				if (data.baseModelId !== undefined) state.baseModelId = data.baseModelId;
				if (data.largeModelId !== undefined) state.largeModelId = data.largeModelId;
				if (data.provider !== undefined) state.provider = data.provider;
				if (data.baseContextWindow !== undefined) state.baseContextWindow = data.baseContextWindow;
				if (data.threshold !== undefined) state.threshold = data.threshold;
				if (data.userSelectedId !== undefined) state.userSelectedId = data.userSelectedId;
			}
		}

		updateStatus(ctx);
	});

	// -----------------------------------------------------------------------
	// Track model changes
	// -----------------------------------------------------------------------
	pi.on("model_select", async (event, ctx) => {
		const { model, source } = event;

		// Ignore model_select events that we triggered ourselves
		if (selfSwitch) return;

		// If restoring a session and we already have state, don't re-evaluate
		if (source === "restore" && state.baseModelId) {
			updateStatus(ctx);
			return;
		}

		// Look up the pair for whatever model the user selected
		const match = findPair(model.id, model.provider);

		if (!match) {
			// Not a supported model — clear hybrid state
			state.switched = false;
			state.baseModelId = undefined;
			state.largeModelId = undefined;
			state.provider = undefined;
			state.baseContextWindow = undefined;
			state.userSelectedId = undefined;
			updateStatus(ctx);
			return;
		}

		const { pair, selectedSide } = match;

		state.switched = false;
		state.baseModelId = pair.baseId;
		state.largeModelId = pair.largeId;
		state.provider = pair.provider;
		state.userSelectedId = model.id;

		if (selectedSide === "large") {
			// User selected the 1M model — drop down to the 200k base immediately
			const baseModel = ctx.modelRegistry.find(pair.provider, pair.baseId);
			if (baseModel) {
				state.baseContextWindow = baseModel.contextWindow;

				selfSwitch = true;
				const ok = await pi.setModel(baseModel);
				selfSwitch = false;

				if (ok) {
					if (source !== "restore") {
						ctx.ui.notify(
							`🔀 Hybrid context: starting on ${pair.baseId} (200k), will switch to ${pair.largeId} (1M) at ${formatPercent(state.threshold)}`,
							"info",
						);
					}
				} else {
					// Can't switch to base — just stay on 1M, no hybrid
					ctx.ui.notify(
						`⚠️ Hybrid context: no API key for base model "${pair.baseId}". Staying on 1M.`,
						"warning",
					);
					state.switched = true;
				}
			} else {
				// Base model not found — stay on 1M
				state.baseContextWindow = model.contextWindow;
				state.switched = true;
				if (source !== "restore") {
					ctx.ui.notify(
						`⚠️ Hybrid context: base model "${pair.baseId}" not found. Staying on 1M.`,
						"warning",
					);
				}
			}
		} else {
			// User selected the 200k base model — just monitor
			state.baseContextWindow = model.contextWindow;

			if (source !== "restore") {
				ctx.ui.notify(
					`🔀 Hybrid context active: will switch to ${pair.largeId} (1M) at ${formatPercent(state.threshold)}`,
					"info",
				);
			}
		}

		pi.appendEntry(CUSTOM_TYPE, { ...state });
		updateStatus(ctx);
	});

	// -----------------------------------------------------------------------
	// Monitor context usage after each turn
	// -----------------------------------------------------------------------
	pi.on("turn_end", async (_event, ctx) => {
		if (state.switched || !state.largeModelId || !state.baseContextWindow) {
			updateStatus(ctx);
			return;
		}

		const usage = ctx.getContextUsage();
		if (!usage) return;

		const ratio = usage.tokens / state.baseContextWindow;
		updateStatus(ctx, usage.tokens);

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
		if (!state.largeModelId || !state.provider) return;

		const largeModel = ctx.modelRegistry.find(state.provider, state.largeModelId);
		if (!largeModel) {
			ctx.ui.notify(
				`⚠️ Hybrid context: 1M model "${state.largeModelId}" not found. Continuing on current model.`,
				"warning",
			);
			return;
		}

		selfSwitch = true;
		const success = await pi.setModel(largeModel);
		selfSwitch = false;

		if (!success) {
			ctx.ui.notify(
				`⚠️ Hybrid context: no API key for 1M model "${state.largeModelId}". Continuing on current model.`,
				"warning",
			);
			return;
		}

		state.switched = true;
		pi.appendEntry(CUSTOM_TYPE, { ...state });

		const fromTokens = formatTokens(currentTokens);
		const fromWindow = formatTokens(state.baseContextWindow!);
		ctx.ui.notify(
			`🔀 Switched to 1M context (was ${fromTokens}/${fromWindow}). Model: ${state.largeModelId}`,
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
					"Hybrid context is not active. Select a supported Anthropic model (e.g., claude-sonnet-4-5 or claude-opus-4-6).",
					"info",
				);
				return;
			}

			const usage = ctx.getContextUsage();
			const tokens = usage?.tokens ?? 0;
			const ratio = state.baseContextWindow ? tokens / state.baseContextWindow : 0;

			let msg = `🔀 Hybrid Context Status\n`;
			msg += `  User selected:  ${state.userSelectedId}\n`;
			msg += `  Base model:     ${state.baseModelId} (${formatTokens(state.baseContextWindow ?? 0)})\n`;
			msg += `  1M model:       ${state.largeModelId}\n`;
			msg += `  Current usage:  ${formatTokens(tokens)} (${formatPercent(ratio)})\n`;
			msg += `  Threshold:      ${formatPercent(state.threshold)}\n`;
			msg += `  Switched:       ${state.switched ? "Yes ✓ (on 1M)" : "No — running on base"}`;

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
