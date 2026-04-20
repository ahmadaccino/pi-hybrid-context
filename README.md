# pi-hybrid-context

A [pi](https://github.com/badlogic/pi) extension that implements **hybrid context** for Anthropic models — start on a standard 200k context-window model for speed and cost savings, then automatically switch to the 1M context-window variant when you're approaching the limit.

## Why?

Anthropic's latest models (Claude Opus 4.6, Claude Sonnet 4.6) support 1M token context windows, but they can be slower and more expensive than their 200k counterparts. For most of a coding session, 200k tokens is plenty. But when you're deep into a long session with lots of tool calls and file reads, you can hit the limit.

**Hybrid context** gives you the best of both worlds:
- **Start cheap & fast** on the 200k model
- **Auto-escalate to 1M** when you actually need it (at 90% context usage by default)
- **One-way switch** — once on 1M, you stay there for the rest of the session

## Install

```bash
pi install git:github.com/ahmadaccino/pi-hybrid-context
```

Or try it without installing:

```bash
pi -e git:github.com/ahmadaccino/pi-hybrid-context
```

## How It Works

**Works both ways — select either the 200k or the 1M model:**

### Select a 200k model (e.g. `claude-sonnet-4-5`)
1. Extension detects it has a 1M pair (`claude-sonnet-4-6`)
2. Monitors context usage after each turn
3. At 90%, switches to the 1M model

### Select a 1M model (e.g. `us.anthropic.claude-opus-4-6-v1`)
1. Extension detects it has a 200k base (`us.anthropic.claude-opus-4-5-20251101-v1:0`)
2. **Immediately drops down** to the 200k model
3. Monitors context usage after each turn
4. At 90%, switches back to the 1M model you originally selected

Either way, you get a notification and the status bar tracks progress.

## Supported Model Pairs

### Anthropic Direct API

| Base Model (200k) | ↔ | 1M Model |
|---|---|---|
| `claude-sonnet-4-5` | | `claude-sonnet-4-6` |
| `claude-sonnet-4-5-20250929` | | `claude-sonnet-4-6` |
| `claude-opus-4-5` | | `claude-opus-4-6` |
| `claude-opus-4-5-20251101` | | `claude-opus-4-6` |
| `claude-sonnet-4-0` | | `claude-sonnet-4-6` |
| `claude-opus-4-0` | | `claude-opus-4-6` |
| `claude-opus-4-1` | | `claude-opus-4-6` |

### AWS Bedrock

All region prefixes are supported: bare, `us.`, `eu.`, `global.`

| Base Model (200k) | ↔ | 1M Model |
|---|---|---|
| `[prefix]anthropic.claude-sonnet-4-5-20250929-v1:0` | | `[prefix]anthropic.claude-sonnet-4-6` |
| `[prefix]anthropic.claude-opus-4-5-20251101-v1:0` | | `[prefix]anthropic.claude-opus-4-6-v1` |
| `[prefix]anthropic.claude-sonnet-4-20250514-v1:0` | | `[prefix]anthropic.claude-sonnet-4-6` |
| `[prefix]anthropic.claude-opus-4-20250514-v1:0` | | `[prefix]anthropic.claude-opus-4-6-v1` |
| `[prefix]anthropic.claude-opus-4-1-20250805-v1:0` | | `[prefix]anthropic.claude-opus-4-6-v1` |

### OpenRouter

| Base Model (200k) | ↔ | 1M Model |
|---|---|---|
| `anthropic/claude-sonnet-4.5` | | `anthropic/claude-sonnet-4.6` |
| `anthropic/claude-opus-4.5` | | `anthropic/claude-opus-4.6` |
| `anthropic/claude-sonnet-4` | | `anthropic/claude-sonnet-4.6` |
| `anthropic/claude-opus-4` | | `anthropic/claude-opus-4.6` |
| `anthropic/claude-opus-4.1` | | `anthropic/claude-opus-4.6` |

## Commands

### `/hybrid-context`

Show the current hybrid context status:

```
🔀 Hybrid Context Status
  User selected:  us.anthropic.claude-opus-4-6-v1
  Base model:     us.anthropic.claude-opus-4-5-20251101-v1:0 (200k)
  1M model:       us.anthropic.claude-opus-4-6-v1
  Current usage:  45k (23%)
  Threshold:      90%
  Switched:       No — running on base
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

## State Persistence

The extension persists its state in the session via `pi.appendEntry()`. If you resume a session where the switch already happened, it correctly restores the "already switched" state.

## License

MIT
