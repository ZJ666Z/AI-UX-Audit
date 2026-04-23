# Architecture Reference

This document describes the full system structure of AI UX Audit, including every sub-process and how each one prompts the LLM.

---

## 1. Top-level system topology

```
┌──────────────────────────────────────────────────────────────────┐
│  Figma Desktop                                                   │
│                                                                  │
│  ┌─────────────────────┐        postMessage        ┌──────────────────────────────────┐  │
│  │  code.ts (sandbox)  │ ─────────────────────────▶│  ui.html (plugin iframe)         │  │
│  │                     │                           │                                  │  │
│  │  • inspectFrames()  │◀─────────────────────────│  • LLM engine (all 6 functions)  │  │
│  │  • exportPNGs()     │        postMessage        │  • Tab navigation + rendering    │  │
│  │  • computeGraph     │                           │  • Confirmation layer state      │  │
│  │    Metrics()        │                           │  • i18n (EN / ZH)                │  │
│  │  • writeAnnotations │                           │                                  │  │
│  │    ToCanvas()       │                           └──────────┬───────────────────────┘  │
│  └─────────────────────┘                                      │                          │
│                                                               │ direct HTTPS fetch        │
└───────────────────────────────────────────────────────────────┼──────────────────────────┘
                                                                │
                    ┌───────────────────────────────────────────┤
                    │                                           │
                    ▼                                           ▼
         ┌─────────────────────┐                  ┌──────────────────────┐
         │  api.anthropic.com  │                  │  api.openai.com      │
         │  /v1/messages       │                  │  /v1/chat/completions│
         └─────────────────────┘                  └──────────────────────┘

                          ──── optional bridge path ────

┌──────────────────────────────────────────────────────────────────┐
│  Local machine (npm run bridge:start)                            │
│                                                                  │
│  ┌──────────────────────┐   JSON-RPC   ┌─────────────────────┐  │
│  │  bridge/mcp-server   │ ◀──────────▶ │  Claude Code /      │  │
│  │  .mjs (stdio)        │              │  MCP host           │  │
│  └──────────┬───────────┘              └─────────────────────┘  │
│             │ HTTP                                               │
│  ┌──────────▼───────────┐   REST    ┌────────────────────────┐  │
│  │  bridge/server.mjs   │ ◀───────▶ │  session-store.mjs     │  │
│  │  :3845               │           │  (in-memory sessions)  │  │
│  └──────────────────────┘           └────────────────────────┘  │
│             │ HTTP                                               │
│             └────────────▶ LLM providers (same as plugin)       │
└──────────────────────────────────────────────────────────────────┘
```

**Key rule:** All LLM calls in the plugin path go **directly** from the browser iframe to the provider API — the bridge is never involved. The bridge only drives LLM calls when Claude Code (or another MCP host) calls a tool.

---

## 2. Plugin internal data flow

```
Designer selects FRAME nodes in Figma
             │
             ▼
      code.ts sandbox
      ┌──────────────────────────────────────────────────┐
      │  inspectFrames()                                 │
      │    └─ collect name, id, size, reactions          │
      │  exportPNGs()                                    │
      │    └─ Figma exportAsync({ format:'PNG',          │
      │         constraint: {type:'WIDTH', value:512} }) │
      │  computeGraphMetrics(flowGraph)                  │
      │    └─ DFS happy path, dead ends, dangling        │
      │       reactions, decision points                 │
      │  computeFlowHealthScore(flowMetrics)             │
      │    └─ starts at 100; penalty rules (see §6)      │
      └──────────────────────┬───────────────────────────┘
                             │ postMessage('AUDIT_PAYLOAD')
                             ▼
                    ui.html iframe
      ┌──────────────────────────────────────────────────┐
      │  runAudit(payload)                               │
      │    1. runContextualAudit()  → audits + BA card   │
      │    2. [zh] translateToZh()  → translated fields  │
      │    3. renderGroups()        → cards + ✓/✕ btns   │
      │    4. resetConfirmState()   → fresh session      │
      │    5. showJourneyMetrics()  → Phase 1 scores     │
      │                                                  │
      │  [designer clicks ✓ on ≥1 card]                 │
      │    6. generateEvidenceReport() → holistic plan   │
      │                                                  │
      │  [designer clicks ✓ on evidence items]          │
      │    7. generateDRD()         → 3 solutions + DRD  │
      │                                                  │
      │  [designer clicks Analyze Journey]              │
      │    8. runJourneyAudit()     → journey analysis   │
      │                                                  │
      │  [designer clicks Write to Canvas]              │
      │    postMessage('WRITE_AUDIT_FEEDBACK')           │
      └──────────────────────────────────────────────────┘
                             │ postMessage
                             ▼
                    code.ts sandbox
              writeAnnotationsToCanvas()
              (annotation frames, coloured by severity)
```

---

## 3. `callLLM` — base transport layer

Every LLM call in the plugin routes through a single `callLLM` function:

```
callLLM({ provider, model, apiKey, purpose, prompt, visuals, maxTokens })
         │
         ├── provider === 'openai'
         │     POST https://api.openai.com/v1/chat/completions
         │     body: {
         │       model,
         │       response_format: { type: 'json_object' },   ← always JSON mode
         │       messages: [
         │         { role: 'system', content: purpose },
         │         { role: 'user',   content: [
         │             { type: 'text',      text: prompt },
         │             { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } },  ← per visual
         │           ]
         │         }
         │       ],
         │       max_completion_tokens: maxTokens,           ← NOT max_tokens (GPT-4.1+ compat)
         │       temperature: 0.3
         │     }
         │
         └── provider === 'anthropic'
               POST https://api.anthropic.com/v1/messages
               body: {
                 model,
                 max_tokens: maxTokens,
                 system: purpose,                            ← system prompt as top-level field
                 messages: [
                   { role: 'user', content: [
                       { type: 'text',  text: prompt },
                       { type: 'image', source: { type:'base64', media_type:'image/png', data: ... } },  ← per visual
                     ]
                   }
                 ]
               }

Output → raw string → extractJson() → parsed object
```

**Token budgets per function** (raised in v1.6 for GPT-5 series compatibility):

| Function | `maxTokens` |
|---|---|
| `runContextualAudit`, `extractDecisionCard`, `translateToZh` (default) | 4000 |
| `generateEvidenceReport`, `runJourneyAudit`, `analyzeJourney`, `generateDRD` | 6000 |
| `identifyTargetNodes` (Layer 3b) | 1200 |
| `generateNodeChange` (Layer 3c) | 800 |

---

## 4. LLM sub-process: `extractDecisionCard`

**Trigger:** Designer clicks "Extract Decision Card" in Setup tab.

```
INPUT
  notes: raw meeting notes (freeform string)

SYSTEM PROMPT (purpose)
  "You convert messy product notes into a strict JSON DecisionCard.
   Return only valid JSON with exactly these keys:
     decisionQuestion, businessGoal, businessMetrics, experienceGoal,
     experienceMetrics, drivingLogic, primaryMetric, guardrails,
     constraints, touchpoints.
   businessGoal: one sentence — outcome + metric + direction (e.g. ↑20%).
   businessMetrics: array of quantified metric names with ↑/↓ direction.
   drivingLogic: plain-language causal chain, must show the mechanism.
   touchpoints: device/platform strings, infer from notes if mentioned.
   Do not add markdown or commentary."

USER PROMPT
  "Raw meeting notes:\n{notes}"

VISUALS  []

OUTPUT  →  DecisionCard (10 fields, all strings/string[])

POST-PROCESS
  If lang === 'zh': call translateToZh() on the full card
```

---

## 5. LLM sub-process: `runContextualAudit`  ← primary audit

**Trigger:** Designer clicks "Start Audit"; payload received from code.ts.

```
PRE-PROCESSING (deterministic, no LLM)
  inspectSelectedFlow(payload)
    └─ summarizeFlowGraph() — caps transitions at 80, interactive nodes at 40
  selectVisualsForAudit(visuals, provider)
    └─ Anthropic: up to 8 frames | OpenAI: up to 4 frames
  summarizeDesignVariables(designVariables)
    └─ groups tokens by collection/mode, references names like $brand-danger

SYSTEM PROMPT (purpose)  ← two mandatory sequential parts
  ┌─ PART 1 — Business Analysis ─────────────────────────────────┐
  │  Analyse the DecisionCard. Required fields:                  │
  │    coreAction  — single highest-value user action            │
  │    whyItMatters — why it moves the primary metric            │
  │    businessMetrics — array of {metric, direction, segment}   │
  │    businessLogic — causal chain: UI → behavior → outcome     │
  │    summary — 2-sentence synthesis                            │
  └───────────────────────────────────────────────────────────────┘
  ┌─ PART 2 — UX Issues ──────────────────────────────────────────┐
  │  Cross-reference visuals + flow graph.                        │
  │  Identify exactly 3–5 issues that threaten Part 1 metrics.   │
  │  Sort: critical → warning → suggestion.                      │
  │  Required fields per item:                                   │
  │    targetFrameName, what, where, critiqueType, severity,     │
  │    impactedMetric, why, causalMechanism, guardrailRef,        │
  │    suggestion, provocativeQuestion                           │
  │  If touchpoints include TV: check focus management, D-pad.   │
  │  If touchpoints include Mobile: check thumb zones, 44px.     │
  └───────────────────────────────────────────────────────────────┘
  Return ONLY valid JSON: { businessAnalysis, auditItems }

USER PROMPT
  "Evaluate the following tri-modal payload.
   DecisionCard:      {decisionCard JSON}
   FlowGraphSummary:  {summarizedGraph JSON}
   Attached Visuals:  {comma-separated frame names}
   Omitted Visuals:   {frames dropped for token budget}
   Design Tokens:     {variableSummary JSON | 'none available'}"

VISUALS  selectedVisuals (PNG base64, max 4 or 8)

OUTPUT
  {
    businessAnalysis: { coreAction, whyItMatters, businessMetrics[], businessLogic, summary },
    auditItems: [ { targetFrameName, what, where, critiqueType, severity,
                    impactedMetric, why, causalMechanism, guardrailRef,
                    suggestion, provocativeQuestion } ]
  }

POST-PROCESS
  resolveFrameIds(rawAudits, flowGraph)    ← attach affectedFrameId
  calculateAuditScore(audits)              ← 100 − (critical×15) − (warning×8) − (suggestion×2)
  If lang === 'zh': translateToZh() on audit display fields + BA text fields
  Reset confirmState (new audit = fresh session)
```

---

## 6. Deterministic: Flow Health Score (no LLM)

Computed in `code.ts` from the Figma prototype graph after the audit payload arrives. No LLM is called.

```
computeGraphMetrics(flowGraph)
  ├─ DFS from entry frames (nodes with inboundCount === 0)
  │    preferring non-back edges to build happyPath[]
  ├─ isIntentionalExit(name) — "success / complete / done / confirm / thank"
  │    + Chinese equivalents — skips these from dead-end detection
  ├─ Outputs: totalFrames, happyPath[], deadEnds[], danglingReactionCount,
  │           interactiveNodeCount, decisionPoints, frameMetrics[]
  └─ frameMetrics per frame: { inboundCount, outboundCount,
       danglingReactions, isDeadEnd, decisionPointCount, isHappyPath }

computeFlowHealthScore(flowMetrics)
  starts at 100
  − deadEnds:           first −10, each additional −5, cap −20
  − danglingReactions:  first −5,  each additional −2, cap −10
  − multiple entries:   −5
  − cognitive score:    score < 50 → −5; score < 70 → −3

cognitiveComplexityScore
  = 100 − (decisionPoints × 3) − (deadEnds × 5)
        − (danglingReactions × 2) − (extra happy-path steps)
```

---

## 7. LLM sub-process: `runJourneyAudit` / `analyzeJourney`

**Trigger:** Designer clicks "Analyze Journey" in the Journey sub-tab.

```
PRE-PROCESSING
  If totalFrames > 20:
    filter frameMetrics to risky frames only
    (isDeadEnd || danglingReactions > 0 || decisionPoints > 2 || inboundCount === 0)

SYSTEM PROMPT (purpose)
  "You are a senior UX researcher and interaction design expert
   specializing in user flow analysis.
   Analyze the journey as a whole and output only valid JSON.
   No markdown or commentary."

USER PROMPT
  "FLOW METRICS (computed from Figma graph):  {flowMetrics JSON}
   PER-FRAME METRICS:                         {filteredFrameMetrics JSON}
   DECISION CARD (business context):          {decisionCard JSON}
   EXISTING PER-FRAME AUDIT FINDINGS
   (do not repeat these):                     {existingAudits[0..9] JSON}"

  [journey analysis instructions:]
  • happyPathAssessment: pathMakesSense, misplacedFrames,
    minimumSteps, unnecessaryFriction, summary
  • dropOffPoints: frameName, severity, dropOffType,
    journeyPosition (early/mid/late), whyUsersLeave,
    impactOnGoal, suggestion
  • flowStructureObservations: 3–5 issues NOT in per-frame audit
    (loops, orphaned frames, asymmetric flows, missing error recovery)
  • journeyScoreAdjustment: additionalDeductions[{reason, points, severity}],
    journeySummary

VISUALS  []  (graph metrics are text; no images needed)

OUTPUT
  {
    preScore,        ← Phase 1 flow health score (passed in as context)
    postScore,       ← preScore minus journey deductions
    flowMetrics,
    analysis: {
      happyPathAssessment,
      dropOffPoints[],
      flowStructureObservations[],
      journeyScoreAdjustment
    }
  }
```

---

## 8. LLM sub-process: `generateEvidenceReport`

**Trigger:** Designer has confirmed ≥1 audit finding (Stage 1 gate), then clicks "Generate Evidence Report".

```
PRE-PROCESSING
  Filter to confirmedAuditIndices → auditsToSend (max 20)
  Store _evidenceAuditIndexMap[filteredIdx → originalIdx]
  for DRD context lookup in Stage 2→3

SYSTEM PROMPT (purpose)
  "You are a senior UX researcher.
   You design holistic research plans — not one study per issue.
   Output only valid JSON matching the requested schema.
   No markdown or commentary."

USER PROMPT  ← 5 mandatory steps
  "UX AUDIT FINDINGS (read all together before planning):
   [{index, frameName, what, severity, impactedMetric}]

   DECISION CARD: {decisionCard JSON}

   INSTRUCTIONS — follow all 5 steps:

   Step 1 — Read ALL issues together.
     Identify problem types (cognition / behavior / IA / trust / etc.),
     which issues share a root cause,
     the minimum number of research modules needed.

   Step 2 — Design 1–2 research modules (NOT one per issue):
     moduleA (Qualitative — answers 'Why'):
       method, issuesCovered, whyThisMethod, sampleSize,
       segments, tasks (interview guide outline), setting
     moduleB (Quantitative — answers 'How many / Where'):
       method, issuesCovered, whyThisMethod, timeRange,
       sampleSize, coreMetrics, analysisDimensions

   Step 3 — Simulated findings per module (realistic):
     Each finding must include a concrete number or percentage,
     severity (Critical/Major/Minor), hypothesis reference,
     visualization suggestion.

   Step 4 — Per-issue outputs:
     issueDefinitions: 'In [user+context], because of [design problem],
       users [behavior], which ultimately impacts [business metric].'
     userInsights: cognitive/decision-making mechanism + designImplication.
       NOT a restatement of the UI problem.

   Step 5 — 2–4 hypotheses covering all issues.
     Each must point to a user cognition/decision/behavior mechanism
     and be testable.

   Return ONLY valid JSON: { researchPlan, hypotheses, moduleA, moduleB,
                              issueDefinitions, userInsights }"

VISUALS  []

OUTPUT
  {
    researchPlan:     { problemTypes, rootCauseGroups[], modulesJustification },
    hypotheses:       [ { id, statement, mechanism, testable } ],
    moduleA:          { method, whyThisMethod, issuesCovered, sampleSize,
                        segments, tasks, setting, findings[] },
    moduleB:          { method, whyThisMethod, issuesCovered, timeRange,
                        sampleSize, coreMetrics, analysisDimensions, findings[] },
    issueDefinitions: [ { auditIndex, frameName, severity, definition } ],
    userInsights:     [ { auditIndex, frameName, severity, insight,
                          cognitiveOrBehavioralMechanism, designImplication } ]
  }

POST-PROCESS (rendering)
  Render order: researchPlan → hypotheses → moduleA → moduleB
                → issueDefinitions → userInsights
  Each issueDefinition and userInsight gets a ✓ confirm button (Stage 2→3 gate)
  Confirmed items stored in confirmState.confirmedInsights
    Map<originalAuditIndex, { definition?, insight?,
                               cognitiveOrBehavioralMechanism?, designImplication? }>
```

---

## 9. LLM sub-process: `generateDRD`

**Trigger:** Designer clicks "Generate DRD" on a critical or warning audit card.

```
PRE-PROCESSING
  Look up confirmedContext:
    audit._auditIndex → confirmState.confirmedInsights.get(originalIndex)
  Two paths:
    A) confirmedContext exists  → inject as CONFIRMED RESEARCH CONTEXT block
    B) no confirmation yet      → inject disclaimer, proceed without backing

SYSTEM PROMPT (purpose)
  "You are a senior Product Manager, Interaction Design expert,
   and UX Strategy consultant.
   Output only valid JSON matching the requested schema.
   No markdown or commentary."

USER PROMPT
  "ISSUE:
     Frame:           {targetFrameName}
     Critique type:   {critiqueType}
     Severity:        {severity}
     Problem:         {audit.what}
     Where:           {audit.where}
     Impacted metric: {impactedMetric}
     Why it matters:  {audit.why}

   [Path A — confirmed research:]
   CONFIRMED RESEARCH CONTEXT (designer has reviewed and accepted):
     Issue Definition:               {definition}
     User Insight:                   {insight}
     Cognitive/Behavioral Mechanism: {cognitiveOrBehavioralMechanism}
     Design Implication:             {designImplication}
     Use this confirmed context to ground solutions in verified user behavior.

   [Path B — no confirmation:]
   Note: designer has not confirmed research findings yet.
   Treat issue data as preliminary; apply reasonable assumptions.

   BUSINESS CONTEXT: {decisionCard JSON}

   MANDATORY DIFFERENTIATION CONSTRAINT:
     Declare upfront in dimensionDeclaration which dimension each solution targets:
       Solution 1: information architecture / content hierarchy / interaction path
       Solution 2: visual weight / affordance / feedback mechanisms
       Solution 3: defaults / progressive disclosure / error prevention / copy and guidance
     These three must be different. Same-dimension solutions are not acceptable.

   For each solution, beforeAfter must answer 4 questions:
     before:                   what does the user see and do currently?
     after:                    what is the FIRST thing that is different (not the last)?
     interactionPathChange:    which path is shortened, removed, or restructured?
     meaningfulChangeEvidence: why is this meaningful and not cosmetic?

   COMPARISON TABLE CONSTRAINT:
     Three solutions must differ in scope (Minimal/Surgical | Medium | Structural),
     risk level, and timeline — differences must be immediately obvious."

VISUALS  []

OUTPUT
  {
    dimensionDeclaration: { solution1, solution2, solution3 },
    solutions: [
      {
        name, dimension, coreDirection, coreApproach,
        specificChanges: { informationArchitecture, interactionPath,
                           visualHierarchy, keyElements },
        beforeAfter: { before, after, interactionPathChange,
                       meaningfulChangeEvidence },
        whyBetter, impactOnMetric
      }
    ],
    comparisonTable: [ { solution, dimension, suitableFor, scopeOfChange,
                         risk, businessBenefit, timelineFit } ],
    recommendedIndex: 0,
    drd: {
      background:        { currentProblem, rootCause, businessImpact },
      goals:             { experienceProblems[], businessMetrics[] },
      strategy:          { coreApproach, rationale },
      detailedRedesign:  [ { module, whatChanges, why, userPerception,
                              businessEffect } ],
      risksAndValidation:{ sideEffects[], metricsToMonitor[], validationMethod }
    }
  }
```

---

## 10. Optional LLM sub-process: `translateToZh`

Called after `runContextualAudit` and `extractDecisionCard` when `lang === 'zh'`.

```
SYSTEM PROMPT (purpose)
  "You are a professional translator.
   Translate every string value in the given JSON to Simplified Chinese.
   Preserve the exact JSON structure and all keys.
   Return only valid JSON, no commentary."

USER PROMPT
  "Translate to Simplified Chinese:\n{payload JSON}"
  [If source is an array, wraps as { items: [...] } first,
   then unwraps after parsing — required for OpenAI json_object mode]

VISUALS  []
maxTokens  4000 (default)

OUTPUT  same shape as input, all string values translated
```

---

## 11. Confirmation layer state machine

```
                          ┌─────────────────────────┐
                          │   New audit starts       │
                          │   confirmState.reset()   │
                          └──────────┬──────────────┘
                                     │
                          ┌──────────▼──────────────┐
                          │   Audit cards rendered   │
                          │   Each card has ✓ / ✕    │
                          └──────────┬──────────────┘
                                     │
                     ┌───────────────┴────────────────┐
                     │ ✓ confirm                      │ ✕ dismiss
                     ▼                                ▼
         confirmedAuditIndices.add(i)    confirms cleared for index i
         updateConfirmSummary()           card styled as dismissed
                     │
         [count ≥ 1: Evidence button enabled]
                     │
                     ▼
          ┌─────────────────────────────┐
          │  Generate Evidence Report   │
          │  sends only confirmed items │
          │  builds _evidenceAuditIndex │
          │  Map [filteredIdx→origIdx]  │
          └──────────┬──────────────────┘
                     │
          ┌──────────▼──────────────────┐
          │  Evidence items rendered    │
          │  issueDefinitions + insights│
          │  each has ✓ confirm button  │
          └──────────┬──────────────────┘
                     │ ✓ confirm definition or insight
                     ▼
     confirmedInsights.set(originalIndex, {
       definition?, insight?,
       cognitiveOrBehavioralMechanism?,
       designImplication?
     })
                     │
                     ▼
          ┌─────────────────────────────┐
          │  Generate DRD (any card)    │
          │  lookup: audit._auditIndex  │
          │  → confirmedInsights.get()  │
          └──────────┬──────────────────┘
                     │
          ┌──────────▼──────────────────┐
          │  confirmedContext exists?   │
          ├─ YES → inject CONFIRMED     │
          │         RESEARCH CONTEXT   │
          │         block into prompt  │
          └─ NO  → inject disclaimer   │
                    "not confirmed yet" │
                    + proceed anyway   │
                    └─────────────────┘
```

---

## 12. MCP bridge tool routing

When Claude Code calls an MCP tool, the call path is:

```
Claude Code (MCP host)
  │ JSON-RPC over stdio
  ▼
bridge/mcp-server.mjs
  │ reads tool name + arguments
  ├── inspect_selected_flow
  │     GET /api/session/context → session.flowGraph
  │     → core.inspectSelectedFlow()  [no LLM]
  │
  ├── get_variable_defs
  │     GET /api/session/context → session.designVariables
  │     → core.summarizeDesignVariables()  [no LLM]
  │
  ├── extract_decision_card
  │     → core.extractDecisionCard(provider, model, apiKey, notes)
  │       → callLLM  [maxTokens 4000]
  │
  ├── run_contextual_audit
  │     GET /api/session/context → full payload
  │     → core.runContextualAudit(provider, model, apiKey, payload)
  │       → callLLM  [maxTokens 4000, with visuals]
  │
  ├── generate_evidence_report
  │     (uses session audits + decisionCard from context, or passed directly)
  │     → core.generateEvidenceReport(provider, model, apiKey, audits, dc)
  │       → callLLM  [maxTokens 6000]
  │
  ├── generate_drd
  │     GET /api/session/context → session.audits[auditItemIndex]
  │     → core.generateDRD(provider, model, apiKey, audit, decisionCard)
  │       → callLLM  [maxTokens 6000]
  │       Note: bridge generateDRD does not inject confirmedContext
  │             (confirmation state is plugin-session-only)
  │
  ├── analyze_journey
  │     GET /api/session/context → flowGraph, decisionCard, existingAudits
  │     → core.computeGraphMetrics(flowGraph)  [no LLM]
  │     → core.analyzeJourney(provider, model, apiKey, ...)
  │       → callLLM  [maxTokens 6000]
  │
  └── write_audit_feedback
        → core.prepareWriteAuditFeedback(audits, frameNames)
          [builds annotation message — no LLM]
        POST /api/session/enqueue-plugin-message
          → plugin polls /api/session/pending
          → code.ts writes annotation frames to canvas
```

---

## 13. `extractJson` — LLM output safety net

All LLM responses pass through `extractJson(text)` before use:

```
extractJson(text)
  1. JSON.parse(text)                        → success → return
  2. strip markdown fences (```json...```)   → JSON.parse() → success → return
  3. regex first { ... } or [ ... ]          → JSON.parse() → success → return
  4. step 3 matched but JSON.parse() failed:
       detect truncation heuristics:
         – error message contains "Unexpected end", "Unexpected token",
           or "Expected ',' or"
         – OR match is >500 chars and does not end with } ] " or digit
       if truncation detected:
         throw actionable error:
           "The model response was cut off before the JSON was complete.
            Try: (1) reduce selected frames, (2) switch to Anthropic,
            (3) use a model with a larger context window."
       else:
         throw "Model response contained malformed JSON: {original error}"
  5. no JSON found at all:
       throw "Model response did not contain valid JSON. Raw: {first 200 chars}"
```

**Why truncation detection matters:** GPT-5 series models produce more verbose JSON than GPT-4. A response can be syntactically valid mid-way but get cut off before the closing `}` or `]`, producing an error like `Expected ',' or ']' after array element in JSON at position N`. Without truncation detection this surfaces as a confusing syntax error; with it, the designer gets a direct instruction to switch models or reduce frames.

---

## 14. Visual frame selection logic

```
selectVisualsForAudit(visuals, provider)
  cap = provider === 'anthropic' ? 8 : 4
  return visuals.slice(0, cap)

Each visual: { name: string, base64: string (PNG, width ≤ 512px) }
Images above 512px wide are exported at scale to stay within token budget.
Frames that exceed the cap are named in the userPrompt under
"Frames Without Attached Visuals Due To Token Budget" so the LLM
knows they exist but should rely on the graph summary for them.
```

---

## 15. Canvas interaction message types (Layers 1–3)

All messages between ui.html and code.ts follow the same framing:
- **ui.html → code.ts:** `parent.postMessage({ pluginMessage: { type, ...payload } }, '*')`
- **code.ts → ui.html:** `figma.ui.postMessage({ type, ...payload })`

Received in `window.onmessage` (ui.html) and `figma.ui.onmessage` (code.ts) respectively.

### Layer 1 — FOCUS_FRAME

```
ui.html → code.ts
  type: 'FOCUS_FRAME'
  payload: { frameId: string }

  Handler (async):
    node = await figma.getNodeByIdAsync(frameId)
    if node is not a PAGE or DOCUMENT:
      figma.currentPage.selection = [node]
      figma.viewport.center = { x: bb.x + bb.width/2, y: bb.y + bb.height/2 }
      (pans without changing zoom so nearby sticky notes stay visible)
```

Triggered by clicking the **frame name chip** (blue tonal pill — `background: var(--accent-light)`, `color: var(--accent)`, `↗` suffix) on any audit card header or DRD panel title. The chip replaces the previous dotted-underline approach for better visibility. `affectedFrameId` is set on each audit item by `resolveFrameIds()` which maps `targetFrameName → frame.id` from the flow graph.

### Layer 3a — INSPECT_NODES / NODES_RESULT

```
ui.html → code.ts
  type: 'INSPECT_NODES'
  payload: { frameId: string }

  Handler (async, own try/catch):
    frame = await figma.getNodeByIdAsync(frameId)
    if frame.type !== 'FRAME': post NODES_RESULT with nodes: [], truncated: false

    DFS walk of frame.children (not the frame itself), capped at 60 nodes.
    Per node: { id, name, type, characters?, fills[], visible, width, height, parentName }
    fills: serializable subset — { type, color? } (color only for SOLID fills)
    On any error: post NODES_RESULT with nodes: [], truncated: false
    (ensures loading state always resolves in ui.html)

code.ts → ui.html
  type: 'NODES_RESULT'
  payload: { frameId, nodes: NodeRecord[], truncated: boolean }
```

Sent simultaneously with FOCUS_FRAME on each frame name click. `_frameNodePanels` map routes the response to the correct card's nodes panel by frameId. `audit._nodesData` stores the nodes array for later use by Layer 3b.

### Layer 3b — identifyTargetNodes (LLM, ui.html only)

```
INPUT
  nodes:             audit._nodesData (from NODES_RESULT)
  changeDescription: specificChanges field value for one checklist section
  beforeState / afterState: solutions[recommendedIndex].beforeAfter.before / after

SYSTEM PROMPT
  "You are a Figma node analyst. Given a list of nodes inside a Figma frame
   and a design change description, identify which node IDs are the targets
   of that change. Output only valid JSON:
   { matches: [ { nodeId, nodeName, reason, changeType } ] }
   changeType: text_content | fill_color | visibility | layout | position
   If no confident match, return matches: []. No markdown."

USER PROMPT
  "Frame nodes: {nodesSummary — id, name, type, characters?, fillHex?, width, height}
   Change description: {changeDescription}
   Before state: {beforeState}
   After state:  {afterState}"

maxTokens: 1200
OUTPUT: { matches: [ { nodeId, nodeName, reason, changeType } ] }
```

Triggered lazily when designer clicks "Find nodes" on a checklist item. Result is cached in `matchPanel.dataset.loaded` — the LLM is not re-called if the panel is collapsed and reopened. Only one checklist item's match panel is open at a time (`activeRef` tracks the current one).

### Layer 3c — generateNodeChange (LLM) + APPLY_NODE_CHANGE

```
INPUT (generateNodeChange — ui.html LLM call)
  node:     matched node object from audit._nodesData
  changeType, changeDescription, beforeState, afterState
  guardrails + constraints from _lastDecisionCardForEvidence

SYSTEM PROMPT
  "You are a Figma property editor. Given a node's current state and a
   design change description, output the exact new property value to apply.
   Output only valid JSON matching the changeType:
   text_content: { newText, rationale }
   fill_color:   { r, g, b (each 0–1), rationale }
   visibility:   { visible: boolean }
   layout:       only include keys that change (layoutMode, padding, itemSpacing, alignment)
   position:     { x, y }"

maxTokens: 800

After preview is shown and designer clicks Apply:

ui.html → code.ts
  type: 'APPLY_NODE_CHANGE'
  payload: { nodeId: string, changeType: string, value: object }

  Handler (async, own inner try/catch so it always posts a result):
    node = await figma.getNodeByIdAsync(nodeId)
    switch changeType:
      text_content → loadFontAsync for all ranges → node.characters = newText
      fill_color   → node.fills = [{ type:'SOLID', color:{r,g,b}, opacity:1 }]
      visibility   → node.visible = visible
      layout       → set only provided keys on FrameNode
      position     → node.x = x; node.y = y
    → post NODE_CHANGE_APPLIED on success
    → post NODE_CHANGE_FAILED  on any error (does not rethrow)

code.ts → ui.html
  type: 'NODE_CHANGE_APPLIED'  { nodeId, changeType }
  type: 'NODE_CHANGE_FAILED'   { nodeId, reason }
```

`_pendingNodeChanges` Map<nodeId, { checklistItem, previewDiv, applyBtn, proposedDisplay }> routes responses to the correct UI elements. On `NODE_CHANGE_APPLIED`: preview collapses to "✓ Applied", checklist item checkbox is auto-clicked, node row in the Frame Nodes panel updates its preview text. On `NODE_CHANGE_FAILED`: error shown inline in previewDiv, Apply button re-enabled, preview stays open.

### Serialization safety for write-audit-feedback

The audit objects in `_lastAuditsForEvidence` accumulate non-serializable properties during rendering: `_checklistEl` (DOM element), `_nodesEl` (DOM element), `_nodesData` (array). These cannot pass through `window.postMessage` (Structured Clone Algorithm rejects DOM nodes).

Before posting `write-audit-feedback`, the plugin creates a serializable copy:

```javascript
const serializableAudits = audits.map((a) => ({
  targetFrameName, critiqueType, severity, impactedMetric,
  causalMechanism, guardrailRef, suggestion, provocativeQuestion,
  affectedFrameId, what, where, why,
}));
```

Only plain-data fields are included. DOM refs and session-only props are excluded.

---

## 16. History persistence (clientStorage)

Audit history is persisted across plugin sessions using Figma's `figma.clientStorage` API. The storage key is `'audit_history'`.

### Startup load

```
code.ts (plugin startup)
  figma.clientStorage.getAsync('audit_history')
    → on success with non-empty array:
        figma.ui.postMessage({ type: 'HISTORY_LOADED', snapshots: data })
    → on error or empty: silently skip (start with no history)

ui.html window.onmessage
  type: 'HISTORY_LOADED'
  payload: { snapshots: SnapshotRecord[] }

  Handler:
    incoming = snapshots from storage
    existingTs = Set of timestamps already in state.snapshots
    toAdd = incoming.filter(s => !existingTs.has(s.timestamp))
    state.snapshots = [...toAdd, ...state.snapshots]
    (prepend older stored runs before any in-memory runs from this session)
```

### Save on new run

After each audit completes and `state.snapshots.push(snap)` is called:

```
ui.html
  persistSnapshots()
    Serializes state.snapshots (last 30, strips DOM refs):
      per snapshot: { timestamp, score, severityCounts, audits[] }
      per audit:    { targetFrameName, critiqueType, severity,
                      impactedMetric, provocativeQuestion,
                      what, where, why, affectedFrameId }
    →  parent.postMessage({ pluginMessage: {
          type: 'SAVE_SNAPSHOT', snapshots: clean
       } }, '*')

code.ts
  if msg.type === 'SAVE_SNAPSHOT':
    figma.clientStorage.setAsync('audit_history', msg.snapshots).catch(() => {})
    return
```

The 30-run cap prevents the `clientStorage` from growing indefinitely (Figma enforces ~1 MB per plugin).

### Delete / Clear All

Both actions call `persistSnapshots()` after mutating `state.snapshots`:

```javascript
// Delete one
function deleteSnapshot(timestamp) {
  state.snapshots = state.snapshots.filter(s => s.timestamp !== timestamp);
  persistSnapshots();
  renderHistoryList(state.snapshots);
  renderChart(state.snapshots);
}

// Clear all (after confirm())
function clearAllHistory() {
  state.snapshots = [];
  persistSnapshots();
  renderHistoryList(state.snapshots);
  renderChart(state.snapshots);
}
```

Because `persistSnapshots()` always writes the full current array (including empty `[]`), deleting and clearing are handled by the same mechanism as saving.

### History row expand/collapse

Each history row is a `.history-entry` with a `.history-row` header and a `.history-detail` collapsible body. Clicking the header toggles `entry.classList.toggle('open')`. Only one entry is open at a time — clicking a new row collapses all others first.

The `.history-detail` shows each audit item as a `.history-finding-row`: severity badge + frame name + `what` (or `provocativeQuestion` as fallback).
