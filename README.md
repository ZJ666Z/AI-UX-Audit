# AI UX Audit

A contextual UX auditor that runs directly inside Figma. No backend required for basic use.

The plugin combines three kinds of design context before asking an LLM to critique a flow:

1. **Business context** — a `DecisionCard` extracted from raw meeting notes, including causal business-to-experience logic and touchpoint constraints
2. **Canvas logic** — a deep inspection of selected Figma frames, node reactions, and routing links, including computed graph metrics
3. **Visual context** — compressed PNG exports of the selected frames

Critique results are severity-graded, business-metric-linked, and written back onto the Figma canvas as colour-coded annotation frames.

---

## Architecture

### Plugin (self-contained)

The core audit engine runs **entirely inside the Figma plugin UI** (`ui.html`). All LLM calls go directly from the browser sandbox to the OpenAI or Anthropic API — no local server needed.

| File | Role |
|---|---|
| `ui.html` | Plugin UI + embedded LLM engine |
| `code.ts` / `code.js` | Figma sandbox (frame inspection, PNG export, graph metrics, canvas write-back) |
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
| **Anthropic** | Recommended. Supports up to 8 visual frames per audit. Models: `claude-opus-4-7`, `claude-sonnet-4-6`, etc. |
| **OpenAI** | Supports up to 4 visual frames per audit. Models: `gpt-4o`, `gpt-4.1`, `gpt-5`, etc. Uses `max_completion_tokens` for compatibility with newer models (GPT-4.1+, GPT-5). |

---

## Plugin Features

### DecisionCard

The DecisionCard is the structured business context the LLM uses to evaluate the flow. It is extracted from raw meeting notes by the plugin, and all fields are editable before running the audit.

```json
{
  "decisionQuestion": "Does this onboarding flow help a first-time user reach activation within 3 minutes?",
  "primaryMetric": "Activation rate",
  "businessGoal": "Increase activation rate ↑20%, growth category",
  "businessMetrics": ["activation rate ↑20%", "D7 retention ↑10%"],
  "experienceGoal": "Reduce task completion time ↓30%, increase completion rate ↑20%",
  "experienceMetrics": ["task completion time", "completion rate", "step drop-off rate"],
  "drivingLogic": "When users complete the core setup action in one session, they are more likely to return. Reducing friction at the permissions screen removes the most common abandonment point, which directly raises the activation rate.",
  "touchpoints": ["Mobile (touch)", "Web (mouse + keyboard)"],
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
| `primaryMetric` | The single most important metric |
| `businessGoal` | One sentence: business outcome + metric + direction (e.g. `↑20%`) |
| `businessMetrics` | Array of quantified business metric names with ↑/↓ direction |
| `experienceGoal` | One sentence: user behavior to optimize + experience metric |
| `experienceMetrics` | Array of experience metric names |
| `drivingLogic` | Plain-language causal chain: user behavior change → business outcome change |
| `touchpoints` | Device/platform context array — e.g. `["TV (remote control)"]`. The LLM evaluates interaction patterns (focus management, D-pad nav, tap targets) specific to each touchpoint. |
| `guardrails` | Constraints that must not be violated |
| `constraints` | Engineering or scope constraints |

---

### Tri-modal audit

The plugin sends three signal types to the LLM simultaneously:

- **Visuals** — PNG screenshots of selected Figma frames
- **Flow graph summary** — frame transitions, interactive nodes, dangling reactions, and frame sizes
- **DecisionCard** — full business context including metrics, causal logic, and touchpoints

### Audit output structure

The audit LLM returns a two-part JSON object:

```json
{
  "businessAnalysis": {
    "coreAction": "The one action a user must complete to succeed in this flow",
    "whyItMatters": "Why completing that action drives the primary metric",
    "businessMetrics": ["activation rate ↑20%", "D7 retention ↑10%", "CAC ↓15%"],
    "businessLogic": "Causal chain from user behaviour change to business outcome change",
    "summary": "1–2 sentence executive summary of what the flow is trying to achieve"
  },
  "auditItems": [ ... ]
}
```

**Business Analysis fields:**

| Field | Description |
|---|---|
| `coreAction` | The single user action that determines success in this flow |
| `whyItMatters` | Why completing that action moves the primary metric |
| `businessMetrics` | 3–5 quantified metrics pulled from the DecisionCard |
| `businessLogic` | Plain-language causal chain: user behaviour → business outcome |
| `summary` | Executive summary of what the flow is trying to accomplish |

**Audit item fields:**

| Field | Description |
|---|---|
| `targetFrameName` | Exact name of the Figma frame being critiqued |
| `what` | One-sentence description of the UX problem |
| `where` | Specific UI element, region, or interaction point where the issue occurs |
| `critiqueType` | `Broken Link`, `Missing State`, `Guardrail Conflict`, `Constraint Risk`, or `Flow Ambiguity` |
| `severity` | `critical` / `warning` / `suggestion` |
| `impactedMetric` | Which business or experience metric is affected, with ↑/↓ direction |
| `why` | Why this is a problem — the cognitive or behavioral mechanism |
| `causalMechanism` | `[UI condition] → [user cognitive/behavioral response] → [metric consequence]`. 1–2 sentences. |
| `guardrailRef` | Exact guardrail string from the DecisionCard (or `null`) |
| `suggestion` | One concrete, actionable fix |
| `provocativeQuestion` | A pointed question for the design team |

### Audit card UI

**Business Analysis card** — appears at the top of the Findings sub-tab before individual audit items. Shows `coreAction`, business metric chips, `whyItMatters`, `businessLogic`, and a `summary`.

**Audit result cards** — one per `auditItems` entry, showing:

- Severity chip (Critical / Warning / Suggestion) + left border tint
- **Frame name** (dotted underline, clickable) — pans Figma viewport to that frame and selects it; does not change zoom so nearby canvas annotations stay visible
- Provocative question (always visible)
- **✓ / ✕ confirm buttons** — designer marks each finding as confirmed or dismissed
- **Type** tag + **Impact badge** (purple, shows `impactedMetric`) — visible when expanded
- **What** — description of the problem
- **Where** — specific UI location
- **Suggestion** callout (green)
- **Guardrail violation** callout (amber) — when applicable
- **Why this matters** — collapsible section showing `causalMechanism`
- **Generate DRD** button — visible on `critical` and `warning` items

After a DRD is generated, an **Implementation Checklist** and a **Frame Nodes** panel appear below the card (see Canvas Editing Workflow section).

A **confirmation summary** below the cards shows how many findings are confirmed (e.g. `2 / 4 confirmed`). The **Generate Evidence Report** button is disabled until at least one finding is confirmed.

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

The plugin uses a **4-tab navigation** (Setup · Audit · Results · Trend). The Results tab expands into three sub-tabs.

### Setup tab

Configure your LLM provider, API key, and model. Paste raw meeting notes and click **Extract Decision Card** to auto-fill all DecisionCard fields. The Decision Card form is organized into four sections:

- **Intent** — Decision Question + Primary Metric
- **Business** — Business Goal + Business Metrics
- **Experience** — Experience Goal + Experience Metrics + Driving Logic + Touchpoints
- **Guardrails & Constraints** — side-by-side text areas

All fields are editable after extraction.

### Audit tab

Shows the currently selected Figma frames as chips, an audit progress stepper (Inspect → Analyse → Write back), and the **Start Audit** button.

### Results tab

Contains three sub-tabs:

#### Findings sub-tab

Shows graded audit findings grouped by severity. After an audit completes:
- Click any card to expand it and see the full critique detail
- Click **Generate DRD** on a `critical` or `warning` card to open the DRD slide-over
- Click **Generate Evidence Report** to generate a full UX research simulation

#### Evidence sub-tab

The Evidence Report uses a **holistic research planning** approach: all confirmed audit findings are read together first to identify shared root causes and overlapping patterns before any research module is designed. This produces 1–2 research modules maximum (not one study per issue) and realistic simulated findings with concrete numbers.

Only confirmed audit findings (✓ from Stage 1) are sent to the LLM. The rendered sections appear in this order:

1. **Research Plan** — problem types identified, root cause groups (with issue chips), modules justification (why 1–2 modules cover all issues)
2. **Hypotheses** — 2–4 testable hypotheses, each with an ID badge, the hypothesis statement, cognitive/behavioral mechanism, and testable method
3. **Module A** — qualitative method (interviews, usability testing, or diary study): why this method, issues covered, sample size, time range, and simulated findings with severity ratings, hypothesis references, and visualization suggestions
4. **Module B** — quantitative method (funnel analysis, heatmap, clickstream, or A/B test): same structure as Module A
5. **Issue Definitions** — one per confirmed finding, format: "In [user + context], because of [design problem], users [behavioral consequence], which impacts [business metric]." Each has a **✓ confirm button** for Stage 2→3 gating.
6. **User Insights** — one per confirmed finding, with cognitive/behavioral mechanism and design implication. Each has a **✓ confirm button** for Stage 2→3 gating.

Confirmed issue definitions and user insights are injected as research context into the subsequent DRD call for that finding.

#### Journey sub-tab

After a completed audit, this sub-tab shows a **Flow Health Score** and **Cognitive Complexity Score** computed deterministically from the Figma graph (no LLM needed). Click **Analyze Journey** to run an LLM call that adds:

- **Happy Path Assessment** — does the computed path make sense? Are frames misplaced? Where is unnecessary friction?
- **Drop-off Points** — frames at risk of user abandonment, with journey position (early/mid/late), drop-off type, and concrete suggestion
- **Flow Structure Observations** — 3–5 structural issues not in the per-frame audit (loops, missing error recovery, orphaned frames, asymmetric flows)
- **Journey Score** — post-LLM score after applying penalty deductions to the pre-computed baseline

### Trend tab

Score history chart and audit run log. Shows all audit runs in the current session.

---

## Generate DRD (Redesign Document)

Clicking **Generate DRD** on a `critical` or `warning` audit card opens a slide-over panel. If research findings have been confirmed in the Evidence tab (Stage 2→3), those confirmed definitions and insights are injected as context into the DRD prompt. If not yet confirmed, the LLM receives a disclaimer and generates solutions without research backing.

The panel contains:

- **Dimension declaration** — a brief statement of which design dimension each solution targets before the solutions are shown

- **3 redesign solutions** as tabs, each **targeting a different design dimension**:
  - **Solution 1** — information architecture / content hierarchy / interaction path
  - **Solution 2** — visual weight / affordance / feedback mechanisms
  - **Solution 3** — defaults / progressive disclosure / error prevention / copy and guidance

  Each solution tab shows a **dimension badge** and includes:
  - Core direction and approach
  - Specific changes
  - **Before/after contrast** (4 fields): `before` (current state), `after` (first meaningful difference), `interactionPathChange` (how the user journey changes), `meaningfulChangeEvidence` (why this constitutes a real improvement)
  - Why this solution is better (experience + business reasoning)
  - Estimated impact on the impacted metric

- **Solution comparison table** — columns: Solution | Suitable For | Scope of Change | Risk | Business Benefit Direction | Timeline Fit. The three rows must show clearly different scope, risk, and timeline values.

- **DRD document** for the recommended solution:
  - 4.1 Redesign background (current problem, root cause, business impact)
  - 4.2 Redesign goals (experience problems to fix, business metrics to move)
  - 4.3 Design strategy (core approach + rationale)
  - 4.4 Detailed redesign by module (what changes, why, user perception, business effect)
  - 4.5 Risks and validation (side effects, metrics to monitor, validation method)

- **Copy DRD as Markdown** button — exports the document to clipboard for pasting into Notion, Confluence, or a doc

---

## Canvas Editing Workflow

After a DRD is generated for a `critical` or `warning` audit card, the plugin enables a four-layer progressive canvas-editing workflow. Each layer builds on the previous one.

### Layer 1 — Frame Focus

Click the **dotted-underlined frame name** on any audit card header or on the DRD panel title. Figma pans the viewport to center on that frame and selects it. Zoom level is preserved — sticky note annotations placed to the right of frames stay visible.

This is purely a pan, not a zoom. The frame name in the DRD slide-over header also triggers the same behavior.

### Layer 2 — Implementation Checklist

After a DRD is generated, an **Implementation Checklist** panel appears below the audit card (outside the collapsible card body — always visible). It shows the four `specificChanges` fields from the recommended DRD solution as checkboxes:

- Information Architecture
- Interaction Path
- Visual Hierarchy
- Key Elements

Empty fields are skipped. A **"X / Y done"** counter tracks progress. Checking an item strikes through its text. A collapsible **Before → After** section shows the before state, after state, and interaction path change from the DRD.

Checklist state is in-memory. Generating a new audit resets it. Re-opening a DRD panel for the same item does not reset the checklist.

### Layer 3a — Frame Nodes

When the frame name is clicked (Layer 1), the plugin simultaneously sends `INSPECT_NODES` to code.ts. The Figma sandbox walks the frame's child tree depth-first (capped at 60 nodes) and returns a node list.

A **Frame Nodes** panel appears below the checklist showing each node as a row:

```
node name  |  node type  |  content preview
```

Content preview: first 50 characters of text for TEXT nodes; solid fill hex color for non-text nodes with a solid fill; blank otherwise. If the frame has more than 60 descendants, a "Showing first 60 nodes." note appears.

### Layer 3b — Node Matching

Each checklist item has a **"Find nodes"** button. Clicking it:

1. Shows "Matching…" spinner
2. Calls `identifyTargetNodes` LLM (600 tokens) with the node list and the change description for that section
3. Displays matched nodes with: node name, change type badge (`text_content` / `fill_color` / `visibility` / `layout` / `position`), and reasoning

If no node is a confident match, shows: "No matching node — apply this change manually in Figma."

Only one checklist item can be expanded at a time. The LLM result is cached per item — re-clicking "Find nodes" on the same item does not re-call the LLM.

### Layer 3c — Suggested Edit and Apply

The **"Suggest edit"** button on each matched node becomes active. Clicking it:

1. Calls `generateNodeChange` LLM (300 tokens) to generate the exact new property value
2. Shows a preview inside the expanded item:
   - **Current** — the node's current value (text content, fill hex, or visibility state)
   - **Proposed** — the LLM-generated new value (highlighted green)
   - **Why** — one-sentence rationale
   - **Apply** / **Dismiss** buttons

**Apply** posts `APPLY_NODE_CHANGE` to code.ts, which writes the change to the Figma canvas:
- `text_content` — loads all fonts used in the node, then sets `node.characters`
- `fill_color` — replaces fills with a single solid color (`r`, `g`, `b` each 0–1)
- `visibility` — sets `node.visible`
- `layout` — sets only the layout keys provided (padding, spacing, alignment, layoutMode)
- `position` — sets `node.x` and `node.y`

On **success**: preview collapses to "✓ Applied", the checklist item is auto-checked, and the matching node row in the Frame Nodes panel updates to show the new value.

On **failure**: the error message appears inline. The preview stays open so the designer can copy the proposed value and apply it manually in Figma.

**Dismiss** hides the preview without applying.

---

## Confirmation Layer

The plugin uses a two-stage confirmation model that keeps the designer in control of what the LLM uses as input for downstream steps.

### Stage 1 → 2: Audit findings → Evidence Report

After an audit completes, each audit card in the Findings sub-tab shows a **✓ confirm** and **✕ dismiss** button.

- **✓ confirm** — marks the finding as validated; the card border turns green
- **✕ dismiss** — marks the finding as not relevant; the card border turns red

The **Generate Evidence Report** button is **disabled** until at least one finding is confirmed. When the button is clicked, only the confirmed findings are sent to the Evidence Report LLM — dismissed and unreviewed findings are excluded. This prevents the research simulation from being diluted by false-positive audit items.

A **confirmation summary** (e.g. `2 / 4 confirmed`) is shown below the audit cards to indicate progress.

### Stage 2 → 3: Evidence findings → DRD

The Evidence sub-tab shows Issue Definitions and User Insights sections, each item with a **✓ confirm** button.

Confirming an issue definition or user insight stores that item's text, cognitive/behavioral mechanism, and design implication in session memory keyed to the original audit index.

When **Generate DRD** is clicked on an audit card, the plugin looks up whether the corresponding evidence item was confirmed. If confirmed research context exists, it is injected as a `CONFIRMED RESEARCH CONTEXT` block in the DRD prompt. If not, the prompt includes a note that research findings have not yet been confirmed and the solutions are generated without that backing.

### Session state

All confirmation state is **in-memory** and scoped to the current plugin session. Running a new audit resets all confirmation state.

---

## Journey-Level Audit

The Journey sub-tab provides two-phase analysis of the whole flow.

### Phase 1 — Deterministic graph metrics (runs automatically after audit)

Computed in `code.ts` from the Figma prototype graph, no LLM required:

**Flow Health Score** — starts at 100, deductions for:
- Dead ends (frames with no outbound links that aren't success/confirmation screens): −10 pts first, −5 pts each additional, capped at −20
- Dangling reactions (broken prototype links): −5 pts first, −2 pts each additional, capped at −10
- Multiple entry points: −5 pts
- Low cognitive complexity score: −3 to −5 pts

**Cognitive Complexity Score** — `100 − (decision_points × 3) − (dead_ends × 5) − (dangling_reactions × 2) − (extra_happy_path_steps)`

**Happy Path** — computed via DFS from entry frames, preferring forward-moving transitions. Intentional exits (frames whose names contain "success", "complete", "done", "confirm", "thank", or their Chinese equivalents) are correctly excluded from dead-end detection.

### Phase 2 — LLM journey analysis (click "Analyze Journey")

Sends flow metrics, per-frame metrics (filtered to risky frames if >20 total), DecisionCard, and existing per-frame audit findings to the LLM. Returns:
- `happyPathAssessment` — path logic, misplaced frames, minimum steps, friction points
- `dropOffPoints` — severity, drop-off type, journey position, why users leave, business impact, suggestion
- `flowStructureObservations` — structural issues not already in the per-frame audit
- `journeyScoreAdjustment` — additional deductions applied to the Phase 1 baseline score

---

## Language Support

The plugin supports **English** and **Simplified Chinese** (简体中文).

- The entire UI (labels, buttons, status messages, audit cards, Evidence tab, DRD panel, Journey tab) switches language when you toggle the selector in the header
- The LLM always generates audit results in English for reliability
- When Chinese is selected, a separate translation call is made after the audit completes, translating all display fields (`critiqueType`, `impactedMetric`, `causalMechanism`, `guardrailRef`, `suggestion`, `provocativeQuestion`)
- Annotation frames written to the Figma canvas also use the selected language

---

## Design Tokens

If the Figma file uses local variables, the plugin exports them as a token summary and includes them in the audit prompt. The LLM can then reference specific token names (e.g. `$brand-danger`) in `guardrailRef` when a guardrail relates to color, spacing, or typography.

---

## Audit History and Comparison

- Previous audit results are stored in-session and accessible under the **Trend** tab
- The **Compare** mode in the Results (Findings) sub-tab diffs two audit runs to show added, removed, and unchanged critique items (matched by `targetFrameName` + `critiqueType` + `provocativeQuestion`)

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

> **Note:** Always run `npm run build` after pulling changes that modify `code.ts`. The Figma plugin runs `code.js` (the compiled output), not the TypeScript source.

---

## Basic Plugin Workflow

1. In Figma, select one or more top-level **FRAME** nodes and connect them with prototype arrows
2. Open the **AI UX Audit** plugin
3. In **Setup**, enter your **API key** and choose a **provider** and **model**
4. Paste raw meeting notes and click **Extract Decision Card**
5. Review and edit the DecisionCard fields — pay attention to **Touchpoints** (e.g. `TV (remote control)`) so the audit evaluates platform-appropriate interaction patterns
6. Switch to **Audit** and click **Start Audit**

The plugin will:
- Inspect selected frames and build a flow graph summary + compute graph metrics
- Export compressed PNGs
- Send the tri-modal payload to the LLM
- Display graded critique items with impact badges and causal mechanisms
- Write colour-coded annotation frames to the Figma canvas (red = critical, amber = warning, blue = suggestion), each showing the impacted metric

After the audit:
- Explore **Results → Evidence** to generate a structured UX research report
- Explore **Results → Journey** to see the Flow Health Score and run the journey-level analysis
- Click **Trend** to track score history across runs

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
| `extract_decision_card` | Convert raw meeting notes into a structured DecisionCard (all 10 fields) |
| `run_contextual_audit` | Run a full tri-modal audit against the current plugin session |
| `generate_evidence_report` | Generate a structured UX research evidence report from existing audit findings |
| `generate_drd` | Generate 3 redesign solutions + a DRD document for a specific audit finding |
| `analyze_journey` | Run a journey-level audit: compute graph metrics, then run LLM analysis for drop-off points, happy path assessment, and flow structure observations |
| `write_audit_feedback` | Send audit results back to the plugin for canvas write-back |

### Tool inputs

**`extract_decision_card`**
```
provider, model, apiKey, notes
```
Returns all 10 DecisionCard fields, including `touchpoints` inferred from the meeting notes.

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

**`analyze_journey`**
```
provider, model, apiKey
sessionId
```
Fetches the flow graph and DecisionCard from the session, computes metrics, and runs the LLM journey analysis. Returns `preScore`, `postScore`, `flowMetrics`, `frameMetrics`, and the full `analysis` object.

### Typical MCP call order

```
inspect_selected_flow(sessionId)
get_variable_defs(sessionId)
extract_decision_card(provider, model, apiKey, notes)
run_contextual_audit(sessionId, provider, model, apiKey)
generate_evidence_report(sessionId, provider, model, apiKey)
generate_drd(sessionId, auditItemIndex, provider, model, apiKey)
analyze_journey(sessionId, provider, model, apiKey)
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
- `runJourneyAudit` filters to risky frames only when `totalFrames > 20`

Each LLM function uses a per-call token ceiling tuned to its output size:

| Function | `max_completion_tokens` / `max_tokens` |
|---|---|
| `runContextualAudit`, `extractDecisionCard`, translation | 1800 |
| `generateEvidenceReport`, `runJourneyAudit`, `analyzeJourney` | 3200 |
| `generateDRD` | 3500 |
| `identifyTargetNodes` (Layer 3b) | 600 |
| `generateNodeChange` (Layer 3c) | 300 |

If you hit rate limits, reduce the number of selected frames and re-run.

---

## Troubleshooting

### OpenAI: `'max_tokens' is not supported with this model`

Fixed — the plugin sends `max_completion_tokens` for all OpenAI requests, which is required by GPT-4.1 and newer models.

### Plugin shows "Failed to fetch" on load

The bridge is optional. This warning just means the MCP bridge is not running — normal plugin use (audit, evidence report, DRD, journey analysis) is unaffected. All LLM calls go directly to the provider API.

### MCP tool says session has no audit payload

The bridge only has payload data after the designer has clicked **Start Audit** at least once with frames selected.

### Journey tab shows empty state after audit

Make sure `code.js` is up to date — run `npm run build`. The journey metrics are computed in `code.ts` (compiled to `code.js`); if the compiled file is stale, `flowMetrics` will not be included in the payload and the Journey sub-tab will not activate.

### Journey analysis is blank after clicking "Analyze Journey"

Two common causes:
1. **Frames have no prototype links** — the happy path will be empty and the LLM returns empty arrays. Connect your frames with at least one prototype arrow.
2. **Token truncation** — rare with the current 3200-token ceiling, but if you see a parsing error alert, reduce the number of selected frames.

### OpenAI 429 / request too large

1. Reduce the number of selected frames
2. Switch to a model with a larger context window
3. Consider switching to Anthropic, which supports more visual frames per request

### Frame name click does nothing

The frame name link only appears when `affectedFrameId` is set on the audit item. `affectedFrameId` is populated by `resolveFrameIds()` after the audit runs by matching `targetFrameName` to the `flowGraph.frames` list. If the LLM returns a `targetFrameName` that doesn't exactly match any selected frame name, `affectedFrameId` will be null and the link won't appear.

### Node tree panel stays on "Reading frame…"

This means `NODES_RESULT` never arrived from code.ts. Common causes:

1. **Stale `code.js`** — run `npm run build` to recompile `code.ts`
2. **Node not found** — the frame ID may be invalid if the Figma file was modified after the audit ran. Re-run the audit to refresh frame IDs.

### Sticky note annotations disappeared after clicking a frame name

The frame name click pans the viewport (not zooms). Sticky notes are placed 100px to the right of each frame. If the viewport panned to center on a frame and the zoom level was already high, the notes may be off-screen to the right. Zoom out to see the full canvas area around the audited frames.

### Canvas annotation write-back fails silently

This is caused by the audit objects containing non-serializable properties (DOM element references) when `postMessage` is called. This is handled automatically — the plugin serializes a clean copy of audit data before sending `write-audit-feedback`. If write-back still fails, ensure the selected frames in Figma are still the same frames that were audited.

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
| [`ui.html`](ui.html) | Plugin UI + full embedded LLM engine (audit, evidence report, DRD, journey analysis) |
| [`code.ts`](code.ts) | Figma sandbox source (TypeScript) — frame inspection, graph metrics, canvas write-back |
| [`code.js`](code.js) | Compiled Figma sandbox (run `npm run build` to update) |
| [`manifest.json`](manifest.json) | Plugin manifest |
| [`bridge/core.mjs`](bridge/core.mjs) | Shared logic: audit, evidence report, DRD, journey analysis, translation (also inlined in ui.html) |
| [`bridge/server.mjs`](bridge/server.mjs) | Local HTTP bridge |
| [`bridge/mcp-server.mjs`](bridge/mcp-server.mjs) | MCP stdio server (8 tools) |
| [`bridge/session-store.mjs`](bridge/session-store.mjs) | In-memory session store |
| [`skills/ux-audit.md`](skills/ux-audit.md) | Claude Code skill — step-by-step MCP audit guide |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Full system architecture + every LLM sub-process and prompt structure |
