# UX Audit Skill

Use this skill to run a structured AI UX audit against one or more selected Figma frames.
The audit is **tri-modal**: it combines frame screenshots (visuals), the Figma interaction graph (logic), and a DecisionCard (business context) to produce severity-graded critiques that are written back to the Figma canvas as annotation frames.

---

## Prerequisites

- The **AI UX Audit bridge** must be running locally:
  ```bash
  npm run bridge:start
  ```
- The Figma plugin must be open with one or more top-level frames selected and connected with prototype arrows.
- A `sessionId` is shown in the plugin UI after the bridge connects.

---

## DecisionCard format

Before auditing, you need a DecisionCard. Either fill it in manually in the plugin UI (Setup tab), or extract one from meeting notes using `extract_decision_card`.

```json
{
  "decisionQuestion": "Does this onboarding flow help a first-time user reach their first activated state within 3 minutes?",
  "primaryMetric": "Activation rate (first value action completed)",
  "businessGoal": "Increase activation rate ↑20%, growth category",
  "businessMetrics": ["activation rate ↑20%", "D7 retention ↑10%"],
  "experienceGoal": "Reduce task completion time ↓30%, increase completion rate ↑20%",
  "experienceMetrics": ["task completion time", "completion rate", "step drop-off rate"],
  "drivingLogic": "When users complete the core setup action in one session, they are more likely to return. Reducing friction at the permissions screen removes the most common abandonment point.",
  "touchpoints": ["Mobile (touch)", "Web (mouse + keyboard)"],
  "guardrails": [
    "Must not increase drop-off on the permissions screen",
    "Cannot remove the legal consent step",
    "All error states must use $brand-danger token"
  ],
  "constraints": [
    "No backend changes in this release",
    "Must work on iOS 15 and Android 10",
    "Single engineer, 2-week sprint"
  ]
}
```

**All 10 fields:**

| Field | Type | Description |
|---|---|---|
| `decisionQuestion` | string | The strategic product question this flow answers |
| `primaryMetric` | string | The single north-star metric for this flow |
| `businessGoal` | string | Business outcome + metric + direction in one sentence |
| `businessMetrics` | string[] | Quantified business metric names with ↑/↓ direction |
| `experienceGoal` | string | User behavior to optimize + experience metric in one sentence |
| `experienceMetrics` | string[] | Experience metric names |
| `drivingLogic` | string | Plain-language causal chain: user behavior change → business outcome change |
| `touchpoints` | string[] | Device/platform context — e.g. `["TV (remote control)"]`. The LLM evaluates interaction patterns specific to each touchpoint. |
| `guardrails` | string[] | Hard limits — things the AI must flag as `critical` if violated |
| `constraints` | string[] | Real-world limits that bound suggested solutions |

---

## Step-by-step audit workflow

### Step 1 — (Optional) Inspect the flow graph

Get a quick structural summary before spending LLM tokens on a full audit.

```
Tool: inspect_selected_flow
Arguments:
  sessionId: "<your-session-id>"
```

Review `diagnostics.danglingReactionCount` (broken links) and `diagnostics.interactiveNodeCount`. If `danglingReactionCount` is high, the designer may have incomplete prototype links.

---

### Step 2 — (Optional) Fetch design tokens

Pull Figma variables so the audit can reference token names in `guardrailRef`.

```
Tool: get_variable_defs
Arguments:
  sessionId: "<your-session-id>"
```

If `hasVariables` is true, the subsequent `run_contextual_audit` call will automatically include the token context.

---

### Step 3 — Extract a DecisionCard from notes (optional)

If you have raw meeting notes instead of a structured DecisionCard:

```
Tool: extract_decision_card
Arguments:
  provider: "anthropic"          # or "openai"
  model: "claude-sonnet-4-6"    # or "gpt-4o"
  apiKey: "<your-key>"
  notes: "<paste raw meeting notes here>"
```

The tool infers all 10 fields, including `touchpoints`, from the notes. Review and edit the returned `decisionCard` before proceeding.

---

### Step 4 — Run the contextual audit

This is the core step. It sends visuals + flow graph + DecisionCard + design tokens to the LLM.

```
Tool: run_contextual_audit
Arguments:
  sessionId: "<your-session-id>"
  provider: "anthropic"
  model: "claude-sonnet-4-6"
  apiKey: "<your-key>"
```

The tool fetches the payload from the active bridge session automatically.

**Response shape:**
```json
{
  "businessAnalysis": {
    "coreAction": "The one action a user must complete to succeed in this flow",
    "whyItMatters": "Why completing that action drives the primary metric",
    "businessMetrics": ["activation rate ↑20%", "D7 retention ↑10%", "CAC ↓15%"],
    "businessLogic": "Causal chain from user behaviour change to business outcome change",
    "summary": "1–2 sentence executive summary of what the flow is trying to achieve"
  },
  "auditItems": [
    {
      "targetFrameName": "Onboarding / Step 2 — Permissions",
      "what": "No recovery path after location permission denial",
      "where": "Permission request dialog — denial state",
      "critiqueType": "Guardrail Conflict",
      "severity": "critical",
      "impactedMetric": "activation rate ↓",
      "why": "Users who deny permission have no visible next step and no way to understand why the permission is needed",
      "causalMechanism": "Missing error recovery on permission denial → user has no path forward → session abandonment → activation rate drops.",
      "guardrailRef": "All error states must use $brand-danger token",
      "suggestion": "Add a denial recovery screen that explains why the permission is needed and offers a 'Skip for now' path. Use the $brand-danger token for the error state.",
      "provocativeQuestion": "If a user denies location access here, what happens — and is the fallback state using the correct $brand-danger token or a hardcoded red?"
    }
  ],
  "score": 72,
  "meta": {
    "attachedVisualFrames": ["Onboarding / Step 1", "Onboarding / Step 2 — Permissions"],
    "omittedVisualFrames": [],
    "graphSummary": {}
  }
}
```

**Severity rules:**

| Severity | Meaning | Score penalty |
|---|---|---|
| `critical` | User cannot complete goal, or a guardrail is directly violated | −15 pts |
| `warning` | Significant friction, ambiguity, or near-violation | −8 pts |
| `suggestion` | Improvement opportunity within constraints | −2 pts |

The `businessAnalysis` block appears as a card at the top of the Results → Findings panel. Use it to verify the LLM correctly interpreted the DecisionCard before reviewing individual findings.

---

### Step 4b — (Optional) Confirm findings before evidence

In the plugin UI, each audit card has **✓ confirm** and **✕ dismiss** buttons. The **Generate Evidence Report** button is disabled until at least one finding is confirmed.

When calling `generate_evidence_report` via MCP, you can pass a filtered `audits` array to replicate this — only include findings you want the research plan to address.

---

### Step 5 — (Optional) Generate a journey-level analysis

After the contextual audit, run a journey-level analysis that looks at the whole flow rather than individual frames.

```
Tool: analyze_journey
Arguments:
  sessionId: "<your-session-id>"
  provider: "anthropic"
  model: "claude-sonnet-4-6"
  apiKey: "<your-key>"
```

**Response shape:**
```json
{
  "preScore": 74,
  "postScore": 62,
  "flowMetrics": {
    "totalFrames": 8,
    "happyPath": ["Home", "Onboarding / Step 1", "Onboarding / Step 2", "Success"],
    "deadEnds": ["Settings / Permissions Denied"],
    "cognitiveComplexityScore": 71
  },
  "analysis": {
    "happyPathAssessment": {
      "pathMakesSense": true,
      "misplacedFrames": [],
      "minimumSteps": 3,
      "unnecessaryFriction": "Profile photo upload appears before core setup — users abandon before completing activation.",
      "summary": "The path is logical but has one avoidable friction point."
    },
    "dropOffPoints": [
      {
        "frameName": "Onboarding / Step 2 — Permissions",
        "severity": "critical",
        "dropOffType": "dead_end",
        "journeyPosition": "mid",
        "whyUsersLeave": "No recovery path after permission denial.",
        "impactOnGoal": "Directly blocks activation — users who deny location access have no way to proceed.",
        "suggestion": "Add a 'Skip location for now' path that reaches the core setup step."
      }
    ],
    "flowStructureObservations": [],
    "journeyScoreAdjustment": {
      "additionalDeductions": [
        { "reason": "Critical dead end blocks activation path", "points": 8, "severity": "critical" }
      ],
      "journeySummary": "The flow has a clean happy path but one critical dead end that blocks a significant portion of users."
    }
  }
}
```

---

### Step 6 — (Optional) Generate an evidence report

Simulate the UX research process that would have discovered the audit findings. The LLM reads all findings together before designing any research module — producing 1–2 modules maximum rather than one study per issue.

```
Tool: generate_evidence_report
Arguments:
  sessionId: "<your-session-id>"
  provider: "anthropic"
  model: "claude-sonnet-4-6"
  apiKey: "<your-key>"
```

**Response shape:**
```json
{
  "researchPlan": {
    "problemTypes": ["navigation clarity", "error recovery", "information hierarchy"],
    "rootCauseGroups": [
      { "groupName": "Missing feedback states", "issueIndices": [0, 2] }
    ],
    "modulesJustification": "Both issues share a root cause (absent system feedback) and can be addressed by a single usability study + funnel analysis"
  },
  "hypotheses": [
    {
      "id": "H1",
      "statement": "Users who encounter the permissions screen without context abandon the flow",
      "cognitiveMechanism": "Uncertainty aversion — users default to denial when the value exchange is unclear",
      "testableMethod": "Task-based usability test with think-aloud protocol"
    }
  ],
  "moduleA": {
    "method": "Moderated usability testing",
    "why": "Direct observation of decision points is needed to understand abandonment triggers",
    "issuesCovered": [0, 2],
    "sampleSize": "8 participants",
    "timeRange": "2 weeks",
    "findings": [
      {
        "issueIndex": 0,
        "finding": "6/8 participants tapped 'Deny' before reading the explanation text",
        "severity": "critical",
        "hypothesisRef": "H1",
        "suggestedVisualization": "Task completion funnel by step"
      }
    ]
  },
  "moduleB": {
    "method": "Funnel analysis + exit heatmap",
    "why": "Quantify the drop-off rate at the permissions screen at scale",
    "issuesCovered": [0, 1, 2],
    "sampleSize": "30-day cohort, ~12 000 sessions",
    "timeRange": "30 days",
    "findings": []
  },
  "issueDefinitions": [
    {
      "auditIndex": 0,
      "definition": "In first-time users completing onboarding, because the permissions screen shows a request without context, users deny access and have no recovery path, which blocks activation and causes session abandonment."
    }
  ],
  "userInsights": [
    {
      "auditIndex": 0,
      "insight": "Users experiencing uncertainty on the permissions screen exhibited loss-aversion behaviour — they preferred denying an unclear request over risking an unknown consequence.",
      "cognitiveOrBehavioralMechanism": "Loss aversion under ambiguity",
      "designImplication": "Reframe the permission request around the user benefit before asking; add a visible 'Skip for now' option to reduce perceived risk"
    }
  ]
}
```

In the plugin UI, each item in `issueDefinitions` and `userInsights` has a **✓ confirm** button (Stage 2→3 gating). Confirmed items are injected as research context into the subsequent DRD call for that finding.

---

### Step 7 — (Optional) Generate a DRD for a specific finding

For any `critical` or `warning` audit item, generate 3 redesign solutions and a full DRD document. Each solution **must target a different design dimension** (no two solutions can address the same level of the design):

- **Solution 1** — information architecture / content hierarchy / interaction path
- **Solution 2** — visual weight / affordance / feedback mechanisms
- **Solution 3** — defaults / progressive disclosure / error prevention / copy and guidance

```
Tool: generate_drd
Arguments:
  sessionId: "<your-session-id>"
  auditItemIndex: 0              # 0-based index into the audits array
  provider: "anthropic"
  model: "claude-sonnet-4-6"
  apiKey: "<your-key>"
```

**Response shape:**
```json
{
  "dimensionDeclaration": "Solution 1 targets interaction path; Solution 2 targets feedback mechanisms; Solution 3 targets copy and progressive disclosure",
  "solutions": [
    {
      "name": "Restructure Permission Flow",
      "dimension": "Information Architecture / Interaction Path",
      "coreDirection": "Move the permission request after the user has experienced value",
      "specificChanges": ["Delay location prompt until after first core action", "Add a pre-permission value screen"],
      "beforeAfter": {
        "before": "Permission request shown on step 2, before user has any context",
        "after": "Permission request delayed until step 4, after user completes first action",
        "interactionPathChange": "User now reaches core setup before encountering the permission gate — activation path no longer blocked by a cold permission request",
        "meaningfulChangeEvidence": "Value-first sequencing increases permission grant rates by 20–40% in comparable onboarding flows"
      },
      "whyBetter": "Contextual permission requests convert at higher rates because users understand the value exchange",
      "estimatedImpact": "activation rate ↑12–18%",
      "recommended": true,
      "comparisonRow": {
        "suitableFor": "Flows where core value can be demonstrated before requiring permissions",
        "scopeOfChange": "Structural — requires reordering 3+ screens",
        "risk": "Medium — requires QA across all permission states",
        "businessBenefitDirection": "Activation rate ↑, permission grant rate ↑",
        "timelineFit": "2-week sprint (structural change)"
      }
    }
  ],
  "comparisonTable": [ ... ],
  "recommendedSolutionIndex": 0,
  "drdDocument": "..."
}
```

The comparison table rows must show **clearly different** scope, risk, and timeline values across the three solutions. Copy the `drdDocument` as Markdown to paste into Notion or Confluence.

---

### Step 8 — Write feedback back to the Figma canvas

Send the audit results back to the plugin. Annotation frames will be placed to the right of each audited frame, colour-coded by severity (red / amber / blue) with the `impactedMetric` shown inline.

```
Tool: write_audit_feedback
Arguments:
  sessionId: "<your-session-id>"
  audits: <paste the audits array from Step 4>
```

The plugin will scroll the viewport to the created annotation frames automatically.

---

## Audit critique types

| Type | When to use |
|---|---|
| `Broken Link` | A reaction targets a node/frame that doesn't exist in the selection |
| `Missing State` | An expected state (empty, error, loading) is absent from the flow |
| `Guardrail Conflict` | The flow violates one of the DecisionCard guardrails |
| `Constraint Risk` | A proposed pattern would be impossible within the stated constraints |
| `Flow Ambiguity` | It is unclear what happens next — the user has no reliable mental model |

---

## Chaining tools for autonomous audit

For an automated, single-prompt audit, call the tools in this order:

1. `inspect_selected_flow` — verify the flow has content and identify structural issues
2. `get_variable_defs` — load token context
3. `extract_decision_card` — (if notes available) structure business context with all 10 fields
4. `run_contextual_audit` — run the per-frame audit; response includes `businessAnalysis` + `auditItems`
5. Review the `businessAnalysis` block to confirm the LLM correctly read the DecisionCard
6. `generate_evidence_report` — pass only the `auditItems` you want researched (equivalent to the designer confirming findings in the UI)
7. `analyze_journey` — run the journey-level analysis
8. `generate_drd` — generate redesign solutions for the most critical finding (index 0); optionally pass confirmed `issueDefinitions`/`userInsights` from the evidence report as `confirmedContext` for a richer DRD
9. `write_audit_feedback` — write results to canvas

If any step returns an error about a missing audit payload, ask the user to click **Start Audit** in the Figma plugin UI first (or ensure the plugin is open with frames selected).

---

## Touchpoints and platform-aware critique

If the DecisionCard includes `touchpoints` (e.g. `["TV (remote control)"]`), the LLM audits interaction patterns specific to that device:

- **TV / remote control** — focus management, D-pad navigation, 10-foot UI, no hover states, remote-friendly tap targets
- **Mobile / touch** — thumb zones, swipe gestures, minimum 44px tap targets
- **Web / mouse + keyboard** — hover states, keyboard accessibility, cursor affordances

Set touchpoints in the Setup tab or include device context in the raw meeting notes passed to `extract_decision_card`.

---

## Canvas Editing (Plugin UI only — Layers 1–3)

These features are only available in the Figma plugin UI. They are not exposed as MCP tools because they depend on real-time DOM state and in-session confirmation state.

### Layer 1 — Frame Focus

Click the dotted-underlined frame name on any audit card → Figma pans to that frame and selects it. The viewport zoom level is unchanged so nearby sticky note annotations remain visible. The DRD panel title also has a clickable frame name.

### Layer 2 — Implementation Checklist

After generating a DRD, an **Implementation Checklist** appears below the audit card. It contains the four `specificChanges` fields from the recommended solution as checkboxes, plus a collapsible Before → After section. The checklist persists as long as the session is active. Re-running the audit clears it.

### Layer 3a — Frame Nodes

Clicking a frame name also inspects the node tree (depth-first, ≤60 nodes). A "Frame Nodes" panel appears below the checklist. Each row: name | type | text preview or fill hex.

### Layer 3b — Node Matching

Each checklist item has a "Find nodes" button. Clicking triggers an LLM call (600 tokens) to identify which node(s) the change targets and what property type to edit (`text_content`, `fill_color`, `visibility`, `layout`, `position`). Results are cached per item.

### Layer 3c — Suggest Edit + Apply

"Suggest edit" on a matched node triggers an LLM call (300 tokens) to generate the exact new property value. A current / proposed preview with Apply / Dismiss appears. Apply writes the change directly to the Figma canvas via the plugin sandbox (`APPLY_NODE_CHANGE` message → `code.ts`). Success auto-checks the checklist item.
