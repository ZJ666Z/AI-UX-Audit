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
  "audits": [
    {
      "targetFrameName": "Onboarding / Step 2 — Permissions",
      "critiqueType": "Guardrail Conflict",
      "severity": "critical",
      "impactedMetric": "activation rate ↓",
      "causalMechanism": "Missing error recovery on permission denial → user has no path forward → session abandonment → activation rate drops.",
      "guardrailRef": "All error states must use $brand-danger token",
      "suggestion": "Add a denial recovery screen that explains why the permission is needed and offers a 'Skip for now' path. Use the $brand-danger token for the error state.",
      "provocativeQuestion": "If a user denies location access here, what happens — and is the fallback state using the correct $brand-danger token or a hardcoded red?",
      "affectedFrameId": "123:456"
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

Simulate the UX research process that would have discovered the audit findings.

```
Tool: generate_evidence_report
Arguments:
  sessionId: "<your-session-id>"
  provider: "anthropic"
  model: "claude-sonnet-4-6"
  apiKey: "<your-key>"
```

Returns a structured report with: issue overview, research hypotheses, research design (qualitative + quantitative modules), simulated results, issue definitions, and user insights.

---

### Step 7 — (Optional) Generate a DRD for a specific finding

For any `critical` or `warning` audit item, generate 3 redesign solutions and a full DRD document.

```
Tool: generate_drd
Arguments:
  sessionId: "<your-session-id>"
  auditItemIndex: 0              # 0-based index into the audits array
  provider: "anthropic"
  model: "claude-sonnet-4-6"
  apiKey: "<your-key>"
```

Returns 3 solution options with before/after contrast, a comparison table, and a full DRD document for the recommended solution. Copy the DRD as Markdown to paste into Notion or Confluence.

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
4. `run_contextual_audit` — run the per-frame audit
5. `analyze_journey` — run the journey-level analysis
6. `generate_evidence_report` — simulate the research backing
7. `generate_drd` — generate redesign solutions for the most critical finding (index 0)
8. `write_audit_feedback` — write results to canvas

If any step returns an error about a missing audit payload, ask the user to click **Start Audit** in the Figma plugin UI first (or ensure the plugin is open with frames selected).

---

## Touchpoints and platform-aware critique

If the DecisionCard includes `touchpoints` (e.g. `["TV (remote control)"]`), the LLM audits interaction patterns specific to that device:

- **TV / remote control** — focus management, D-pad navigation, 10-foot UI, no hover states, remote-friendly tap targets
- **Mobile / touch** — thumb zones, swipe gestures, minimum 44px tap targets
- **Web / mouse + keyboard** — hover states, keyboard accessibility, cursor affordances

Set touchpoints in the Setup tab or include device context in the raw meeting notes passed to `extract_decision_card`.
