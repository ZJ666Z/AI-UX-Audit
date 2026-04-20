# AI UX Audit

A contextual UX auditor that runs directly inside Figma. No backend required for basic use.

The plugin combines three kinds of design context before asking an LLM to critique a flow:

1. **Business context** — a `DecisionCard` extracted from raw meeting notes, including causal business-to-experience logic
2. **Canvas logic** — a deep inspection of selected Figma frames, node reactions, and routing links
3. **Visual context** — compressed PNG exports of the selected frames

Critique results are severity-graded, business-metric-linked, and written back onto the Figma canvas as colour-coded annotation frames.

---

## Architecture

### Plugin (self-contained)

The core audit engine runs **entirely inside the Figma plugin UI** (`ui.html`). All LLM calls go directly from the browser sandbox to the OpenAI or Anthropic API — no local server needed.

| File | Role |
|---|---|
| `ui.html` | Plugin UI + embedded LLM engine |
| `code.ts` / `code.js` | Figma sandbox (frame inspection, PNG export, canvas write-back) |
| `manifest.json` | Plugin manifest; declares `allowedDomains` for api.openai.com and api.anthropic.com |

### Bridge (optional — MCP / Claude Code only)

The `bridge/` directory adds an optional local HTTP server and MCP stdio server. This is only needed if you want to drive audits from Claude Code or another MCP host instead of from the plugin UI.

| File | Role |
|---|---|
| `bridge/server.mjs` | HTTP server (port 3845) |
| `bridge/core.mjs` | Shared audit logic (also inlined in `ui.html`) |
| `bridge/session-store.mjs` | In-memory session registry |
| `bridge/mcp-server.mjs` | MCP stdio server |
| `bridge/mcp.config.example.json` | Starter Claude Desktop / Claude Code MCP config |

---

## Supported LLM Providers

| Provider | Notes |
|---|---|
| **Anthropic** | Recommended. Supports up to 8 visual frames per audit. Models: `claude-opus-4-6`, `claude-sonnet-4-6`, etc. |
| **OpenAI** | Supports up to 4 visual frames per audit. Models: `gpt-4o`, `gpt-4.1`, `gpt-5`, etc. Uses `max_completion_tokens` for compatibility with newer models (GPT-4.1+, GPT-5). |

---

## Plugin Features

### DecisionCard

The DecisionCard is the structured business context the LLM uses to evaluate the flow. It is extracted from raw meeting notes by the plugin, and all fields are editable before running the audit.

```json
{
  "decisionQuestion": "Does this onboarding flow help a first-time user reach activation within 3 minutes?",
  "businessGoal": "Increase activation rate ↑20%, growth category",
  "businessMetrics": ["activation rate ↑20%", "D7 retention ↑10%"],
  "experienceGoal": "Reduce task completion time ↓30%, increase completion rate ↑20%",
  "experienceMetrics": ["task completion time", "completion rate", "step drop-off rate"],
  "drivingLogic": "When users complete the core setup action in one session, they are more likely to return. Reducing friction at the permissions screen removes the most common abandonment point, which directly raises the activation rate.",
  "primaryMetric": "Activation rate",
  "guardrails": [
    "Must not increase drop-off on the permissions screen",
    "All error states must use $brand-danger token"
  ],
  "constraints": [
    "No backend changes in this release",
    "Single engineer, 2-week sprint"
  ]
}
```

**Field descriptions:**

| Field | Description |
|---|---|
| `decisionQuestion` | The core UX hypothesis being tested |
| `businessGoal` | One sentence: business outcome + metric + direction (e.g. `↑20%`) |
| `businessMetrics` | Array of quantified business metric names with ↑/↓ direction |
| `experienceGoal` | One sentence: user behavior to optimize + experience metric |
| `experienceMetrics` | Array of experience metric names |
| `drivingLogic` | Plain-language causal chain: user behavior change → business outcome change |
| `primaryMetric` | The single most important metric |
| `guardrails` | Constraints that must not be violated |
| `constraints` | Engineering or scope constraints |

---

### Tri-modal audit

The plugin sends three signal types to the LLM simultaneously:

- **Visuals** — PNG screenshots of selected Figma frames
- **Flow graph summary** — frame transitions, interactive nodes, dangling reactions, and frame sizes
- **DecisionCard** — full business context including metrics and causal logic

### Audit output

Each audit item contains:

| Field | Description |
|---|---|
| `targetFrameName` | Exact name of the Figma frame being critiqued |
| `critiqueType` | `Broken Link`, `Missing State`, `Guardrail Conflict`, `Constraint Risk`, or `Flow Ambiguity` |
| `severity` | `critical` / `warning` / `suggestion` |
| `impactedMetric` | Which business or experience metric is affected, with ↑/↓ direction. References metrics from the DecisionCard where possible. |
| `causalMechanism` | `[UI condition] → [user cognitive/behavioral response] → [metric consequence]`. 1–2 sentences, no vague claims. |
| `guardrailRef` | Exact guardrail string from the DecisionCard (or `null`) |
| `suggestion` | One concrete, actionable fix |
| `provocativeQuestion` | A pointed question for the design team |

### Audit card UI

Each audit result card in the plugin panel shows:

- Severity bar (red / amber / blue)
- Frame name + provocative question (always visible)
- **Type** tag + **Impact badge** (purple, shows `impactedMetric`) — visible when expanded
- **Suggestion** callout (green)
- **Guardrail violation** callout (amber) — when applicable
- **Why this matters** — collapsible section showing `causalMechanism`, hidden by default
- **Generate DRD** button — visible on `critical` and `warning` items

### Severity and score

| Severity | Meaning | Score deduction |
|---|---|---|
| `critical` | User cannot complete their goal, or a guardrail is violated | −15 pts |
| `warning` | Significant friction, ambiguity, or near-violation | −8 pts |
| `suggestion` | Improvement opportunity within constraints | −2 pts |

The score starts at 100. Minimum is 0.

### Canvas annotation write-back

Annotation frames written to the Figma canvas include:
- Critique type + frame name (title)
- Provocative question (body)
- Impacted metric (shown as `📉 metric name`) — so designers see the business impact directly on canvas

---

## Plugin Tabs

### Setup tab

Configure your LLM provider, API key, and model. Paste raw meeting notes and click **Extract Decision Card** to auto-fill all DecisionCard fields. All fields are editable after extraction.

### Audit tab

Shows the currently selected Figma frames as chips, an audit progress stepper, and the **Start Audit** button.

### Results tab

Shows graded audit findings grouped by severity. After an audit completes:
- Click any card to expand it and see the full critique detail
- Click **Generate DRD** on a `critical` or `warning` card to open the DRD slide-over
- Click **Generate Evidence Report** (secondary button) to generate a full UX research simulation

### Evidence tab

After clicking "Generate Evidence Report", the plugin generates a structured research document with 6 collapsible sections:

1. **Issue Overview & Research Plan** — issue summary, shared patterns, root causes, module coverage
2. **Research Hypotheses** — 2–4 testable hypotheses pointing to cognitive/behavioral mechanisms
3. **Research Design** — Module A (qualitative: interviews/usability testing) + Module B (quantitative: funnel/heatmap/clickstream)
4. **Simulated Results** — realistic findings with counts, percentages, metric values, and suggested visualization types
5. **Issue Definitions** — one per audit finding, in the format: "In [user + context], because of [design problem], users [behavioral consequence], which impacts [business metric]."
6. **User Insights** — one per finding, with cognitive/behavioral mechanism and design implication

### Trend tab

Score history chart and audit run log.

---

## Generate DRD (Redesign Document)

Clicking **Generate DRD** on a `critical` or `warning` audit card opens a slide-over panel with:

- **3 redesign solutions** shown as tabs, each with:
  - Core direction and approach
  - Specific changes (information architecture, interaction path, visual hierarchy, key elements)
  - Before/after contrast
  - Why this solution is better (experience + business reasoning)
  - Estimated impact on the impacted metric

- **Solution comparison table** — columns: Solution | Suitable For | Scope of Change | Risk | Business Benefit Direction | Timeline Fit

- **DRD document** for the recommended solution:
  - 4.1 Redesign background (current problem, root cause, business impact)
  - 4.2 Redesign goals (experience problems to fix, business metrics to move)
  - 4.3 Design strategy (core approach + rationale)
  - 4.4 Detailed redesign by module (what changes, why, user perception, business effect)
  - 4.5 Risks and validation (side effects, metrics to monitor, validation method)

- **Copy DRD as Markdown** button — exports the document to clipboard for pasting into Notion, Confluence, or a doc

---

## Language Support

The plugin supports **English** and **Simplified Chinese** (简体中文).

- The entire UI (labels, buttons, status messages, audit cards, Evidence tab, DRD panel) switches language when you toggle the selector in the header
- The LLM always generates audit results in English for reliability
- When Chinese is selected, a separate translation call is made after the audit completes, translating all display fields (`critiqueType`, `impactedMetric`, `causalMechanism`, `guardrailRef`, `suggestion`, `provocativeQuestion`)
- Annotation frames written to the Figma canvas also use the selected language

---

## Design Tokens

If the Figma file uses local variables, the plugin exports them as a token summary and includes them in the audit prompt. The LLM can then reference specific token names (e.g. `$brand-danger`) in `guardrailRef` when a guardrail relates to color, spacing, or typography.

---

## Audit History and Comparison

- Previous audit results are stored in-session and accessible under the **Trend** tab
- The **Compare** mode in the Results tab diffs two audit runs to show added, removed, and unchanged critique items (matched by `targetFrameName` + `critiqueType` + `provocativeQuestion`)

---

## Installation

### Plugin only (no bridge)

1. Clone or download this repository
2. In Figma desktop, go to **Plugins → Development → Import plugin from manifest** and select `manifest.json`
3. No `npm install` needed to run the plugin itself

### With bridge / MCP support

```bash
npm install
```

---

## Development Commands

| Command | What it does |
|---|---|
| `npm run build` | Compile `code.ts` → `code.js` |
| `npm run watch` | Watch mode — recompile on save |
| `npm run bridge:start` | Start the local HTTP bridge on port 3845 |
| `npm run bridge:mcp` | Start the MCP stdio server |

---

## Basic Plugin Workflow

1. In Figma, select one or more top-level **FRAME** nodes
2. Open the **AI UX Audit** plugin
3. Enter your **API key** and choose a **provider** and **model**
4. Paste raw meeting notes and click **Extract Decision Card**
5. Review and edit the DecisionCard fields (all 9 fields are editable)
6. Click **Start Audit**

The plugin will:
- Inspect selected frames and build a flow graph summary
- Export compressed PNGs
- Send the tri-modal payload to the LLM
- Display graded critique items with impact badges and causal mechanisms
- Write colour-coded annotation frames to the Figma canvas (red = critical, amber = warning, blue = suggestion), each showing the impacted metric

---

## MCP / Claude Code Workflow

The MCP bridge lets Claude Code (or any MCP host) drive audits against whatever the designer currently has selected in Figma.

### Setup

```bash
# Terminal 1
npm run watch

# Terminal 2
npm run bridge:start
```

Open the plugin in Figma — it will register a `sessionId` with the bridge.

Add the MCP server to your Claude Code or Claude Desktop config (see `bridge/mcp.config.example.json`):

```json
{
  "mcpServers": {
    "ai-ux-audit": {
      "command": "node",
      "args": ["/absolute/path/to/AI UX Audit/bridge/mcp-server.mjs"],
      "env": {
        "BRIDGE_HTTP_URL": "http://localhost:3845"
      }
    }
  }
}
```

### MCP tools

| Tool | Description |
|---|---|
| `inspect_selected_flow` | Summarize the current flow graph (frame transitions, dangling reactions, interactive nodes) |
| `get_variable_defs` | Retrieve Figma design tokens from the active session |
| `extract_decision_card` | Convert raw meeting notes into a structured DecisionCard (all 9 fields) |
| `run_contextual_audit` | Run a full tri-modal audit against the current plugin session |
| `generate_evidence_report` | Generate a structured UX research evidence report from existing audit findings |
| `generate_drd` | Generate 3 redesign solutions + a DRD document for a specific audit finding |
| `write_audit_feedback` | Send audit results back to the plugin for canvas write-back |

### Tool inputs

**`generate_evidence_report`**
```
provider, model, apiKey
sessionId              (OR)
audits[], decisionCard
```

**`generate_drd`**
```
provider, model, apiKey
sessionId + auditItemIndex   (OR)
audit, decisionCard
```

### Typical MCP call order

```
inspect_selected_flow(sessionId)
get_variable_defs(sessionId)
extract_decision_card(provider, model, apiKey, notes)
run_contextual_audit(sessionId, provider, model, apiKey)
generate_evidence_report(sessionId, provider, model, apiKey)
generate_drd(sessionId, auditItemIndex, provider, model, apiKey)
write_audit_feedback(sessionId, audits)
```

---

## HTTP Bridge API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check |
| `/api/session/register` | POST | Register a new plugin session |
| `/api/session/update-context` | POST | Push latest selection + audit payload |
| `/api/session/context` | GET | Retrieve session context by `sessionId` |
| `/api/session/pending` | GET | Poll for queued plugin messages |
| `/api/session/enqueue-plugin-message` | POST | Queue a write-back message for the plugin |
| `/api/session/record-audit` | POST | Store audit score and results on the session |
| `/api/extract-decision-card` | POST | Run DecisionCard extraction |
| `/api/run-contextual-audit` | POST | Run a full contextual audit |
| `/api/inspect-selected-flow` | POST | Summarize a flow graph |

---

## Token Budget

The plugin includes several guardrails to keep LLM request sizes manageable:

- Exported frame images are width-constrained (max 512px) before encoding
- The flow graph is summarized rather than sent raw — frame transitions capped at 80, interactive nodes at 40
- Visual frames per request are capped: **4 for OpenAI**, **8 for Anthropic**
- `generateEvidenceReport` caps audit input at 20 items before sending
- `generateDRD` sends a single audit item — no capping needed

If you hit rate limits, reduce the number of selected frames and re-run.

---

## Troubleshooting

### OpenAI: `'max_tokens' is not supported with this model`

Fixed — the plugin sends `max_completion_tokens` for all OpenAI requests, which is required by GPT-4.1 and newer models.

### Plugin shows "Failed to fetch" on load

The bridge is optional. This warning just means the MCP bridge is not running — normal plugin use (audit, evidence report, DRD) is unaffected. All LLM calls go directly to the provider API.

### MCP tool says session has no audit payload

The bridge only has payload data after the designer has clicked **Start Audit** at least once with frames selected.

### OpenAI 429 / request too large

1. Reduce the number of selected frames
2. Switch to a model with a larger context window
3. Consider switching to Anthropic, which supports more visual frames per request

### Figma manifest rejects the bridge domain

Use `devAllowedDomains` (not `allowedDomains`) for the localhost bridge URL, and use `localhost` rather than `127.0.0.1`:

```json
"networkAccess": {
  "allowedDomains": ["https://api.openai.com", "https://api.anthropic.com"],
  "devAllowedDomains": ["http://localhost:3845"]
}
```

---

## Key Files

| File | Purpose |
|---|---|
| [`ui.html`](ui.html) | Plugin UI + full embedded LLM engine (audit, evidence report, DRD) |
| [`code.ts`](code.ts) | Figma sandbox source (TypeScript) |
| [`code.js`](code.js) | Compiled Figma sandbox |
| [`manifest.json`](manifest.json) | Plugin manifest |
| [`bridge/core.mjs`](bridge/core.mjs) | Shared logic: audit, evidence report, DRD, translation (also inlined in ui.html) |
| [`bridge/server.mjs`](bridge/server.mjs) | Local HTTP bridge |
| [`bridge/mcp-server.mjs`](bridge/mcp-server.mjs) | MCP stdio server (7 tools) |
| [`bridge/session-store.mjs`](bridge/session-store.mjs) | In-memory session store |
| [`skills/ux-audit.md`](skills/ux-audit.md) | Claude Code skill — step-by-step MCP audit guide |
