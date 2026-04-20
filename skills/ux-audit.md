# UX Audit Skill

Use this skill to run a structured AI UX audit against one or more selected Figma frames.
The audit is **tri-modal**: it combines frame screenshots (visuals), the Figma interaction graph (logic), and a DecisionCard (business context) to produce severity-graded critiques that are written back to the Figma canvas as annotation frames.

---

## Prerequisites

- The **AI UX Audit bridge** must be running locally:
  ```bash
  cd bridge && node server.mjs
  ```
- The Figma plugin must be open with one or more top-level frames selected.
- A `sessionId` is shown in the plugin UI after the bridge connects.

---

## DecisionCard format

Before auditing, you need a DecisionCard. Either fill it in manually in the plugin UI, or extract one from meeting notes using `extract_decision_card`.

```json
{
  "decisionQuestion": "Does this onboarding flow help a first-time user reach their first activated state within 3 minutes?",
  "primaryMetric": "Activation rate (first value action completed)",
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

Fields:
| Field | Type | Description |
|---|---|---|
| `decisionQuestion` | string | The strategic product question this flow answers |
| `primaryMetric` | string | The single north-star metric for this flow |
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

Review `diagnostics.danglingReactionCount` (broken links) and `diagnostics.interactiveNodeCount`.

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
  model: "claude-opus-4-6"      # or "gpt-4o"
  apiKey: "<your-key>"
  notes: "<paste raw meeting notes here>"
```

Review and edit the returned `decisionCard` before proceeding.

---

### Step 4 — Run the contextual audit

This is the core step. It sends visuals + flow graph + DecisionCard + design tokens to the LLM.

```
Tool: run_contextual_audit
Arguments:
  sessionId: "<your-session-id>"
  provider: "anthropic"
  model: "claude-opus-4-6"
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
      "guardrailRef": "All error states must use $brand-danger token",
      "suggestion": "Replace the inline red (#FF3B30) with the $brand-danger variable to maintain token consistency.",
      "provocativeQuestion": "If a user denies location access here, what happens — and is the fallback state using the correct $brand-danger token or a hardcoded red?",
      "affectedFrameId": "123:456"
    }
  ],
  "score": 72,
  "meta": {
    "attachedVisualFrames": ["Onboarding / Step 1", "Onboarding / Step 2 — Permissions"],
    "omittedVisualFrames": [],
    "graphSummary": { ... }
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

### Step 5 — Write feedback back to the Figma canvas

Send the audit results back to the plugin. Annotation frames will be placed to the right of each audited frame, colour-coded by severity (red / amber / blue).

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

1. `inspect_selected_flow` — verify the flow has content
2. `get_variable_defs` — load token context
3. `extract_decision_card` — (if notes available) structure business context
4. `run_contextual_audit` — run the audit
5. `write_audit_feedback` — write results to canvas

If any step returns an error about a missing audit payload, ask the user to click **Start Audit** in the Figma plugin UI first.
