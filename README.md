# pi-hybrid-context

A [pi](https://github.com/badlogic/pi) extension that implements **hybrid context** for Anthropic models — start on a standard 200k context-window model for speed and cost savings, then automatically switch to the 1M context-window variant when you're approaching the limit.

## Why?

Anthropic's latest models (Claude Opus 4.6, Claude Sonnet 4.6) support 1M token context windows, but they're slower and more expensive than their 200k counterparts. For most of a coding session, 200k tokens is plenty. But when you're deep into a long session with lots of tool calls and file reads, you can hit the limit.

**Hybrid context** gives you the best of both worlds:
- **Start cheap & fast** on the 200k model
- **Auto-escalate to 1M** when you actually need it (at 90% context usage by default)
- **One-way switch** — once on 1M, you stay there for the rest of the session

## Install

```bash
pi install git:github.com/AhmadMayo/pi-hybrid-context
```

Or try it without installing:

```bash
pi -e git:github.com/AhmadMayo/pi-hybrid-context
```

## How It Works

1. Select any supported base model (e.g., `claude-sonnet-4-5`, `claude-opus-4-5`)
2. The extension detects the model and finds its 1M pair
3. A status indicator appears: `🔀 Hybrid: 200k → 1M at 90%`
4. After each turn, the extension checks context usage via `ctx.getContextUsage()`
5. When usage hits the threshold, it calls `pi.setModel()` to switch to the 1M variant
6. You get a notification: `🔀 Hybrid context: switched to 1M model`

## Supported Model Pairs

### Anthropic Direct API

| Base Model (200k) | 1M Target |
|---|---|
| `claude-sonnet-4-5` | `claude-sonnet-4-6` |
| `claude-sonnet-4-5-20250929` | `claude-sonnet-4-6` |
| `claude-opus-4-5` | `claude-opus-4-6` |
| `claude-opus-4-5-20251101` | `claude-opus-4-6` |
| `claude-sonnet-4-0` | `claude-sonnet-4-6` |
| `claude-opus-4-0` | `claude-opus-4-6` |
| `claude-opus-4-1` | `claude-opus-4-6` |

### AWS Bedrock

All region prefixes are supported: bare, `us.`, `eu.`, `global.`

| Base Model (200k) | 1M Target |
|---|---|
| `[prefix]anthropic.claude-sonnet-4-5-20250929-v1:0` | `[prefix]anthropic.claude-sonnet-4-6` |
| `[prefix]anthropic.claude-opus-4-5-20251101-v1:0` | `[prefix]anthropic.claude-opus-4-6-v1` |
| `[prefix]anthropic.claude-sonnet-4-20250514-v1:0` | `[prefix]anthropic.claude-sonnet-4-6` |
| `[prefix]anthropic.claude-opus-4-20250514-v1:0` | `[prefix]anthropic.claude-opus-4-6-v1` |
| `[prefix]anthropic.claude-opus-4-1-20250805-v1:0` | `[prefix]anthropic.claude-opus-4-6-v1` |

### OpenRouter

| Base Model (200k) | 1M Target |
|---|---|
| `anthropic/claude-sonnet-4.5` | `anthropic/claude-sonnet-4.6` |
| `anthropic/claude-opus-4.5` | `anthropic/claude-opus-4.6` |
| `anthropic/claude-sonnet-4` | `anthropic/claude-sonnet-4.6` |
| `anthropic/claude-opus-4` | `anthropic/claude-opus-4.6` |
| `anthropic/claude-opus-4.1` | `anthropic/claude-opus-4.6` |

## Commands

### `/hybrid-context`

Show the current hybrid context status:

```
🔀 Hybrid Context Status
  Base model:     claude-sonnet-4-5
  1M target:      claude-sonnet-4-6
  Context window: 200k
  Current usage:  45k (23%)
  Threshold:      90%
  Switched:       No — waiting
```

### `/hybrid-threshold <percent>`

Change the switch threshold (default: 90%):

```
/hybrid-threshold 85
```

The threshold persists for the current session.

## Status Bar

When active, you'll see one of these in your status bar:

| Status | Meaning |
|---|---|
| `🔀 Hybrid: 200k → 1M at 90%` | Monitoring, no usage data yet |
| `🔀 Hybrid: 45% of 200k (→1M at 90%)` | Monitoring with current usage |
| `🔀 Hybrid: 1M active` | Already switched to the 1M model |

## Configuration

The default threshold is **90%**. You can change it per-session with `/hybrid-threshold`.

The extension activates automatically when you select a supported model. If you select a model that's already 1M (e.g., `claude-opus-4-6` directly), the extension stays dormant — no switch needed.

## State Persistence

The extension persists its state in the session via `pi.appendEntry()`. If you resume a session where the switch already happened, it correctly restores the "already switched" state.

## License

MIT
