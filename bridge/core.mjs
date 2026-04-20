const MAX_OPENAI_VISUALS = 4;
const MAX_ANTHROPIC_VISUALS = 8;

const SCORE_PENALTIES = { critical: 15, warning: 8, suggestion: 2 };

export function calculateAuditScore(audits) {
  const deductions = (audits || []).reduce((sum, audit) => {
    return sum + (SCORE_PENALTIES[audit.severity] || 0);
  }, 0);
  return Math.max(0, 100 - deductions);
}

function resolveFrameIds(audits, flowGraph) {
  const frameMap = new Map((flowGraph?.frames || []).map((f) => [f.name, f.id]));
  return audits.map((audit) => ({
    ...audit,
    affectedFrameId: frameMap.get(audit.targetFrameName) || null,
  }));
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function dedupeBy(items, getKey) {
  const seen = new Set();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function summarizeFlowGraph(flowGraph) {
  const interactiveNodes = (flowGraph?.nodes || [])
    .filter((node) => node.isInteractive)
    .slice(0, 40)
    .map((node) => ({
      name: node.name,
      frameName: node.frameName,
      path: (node.path || []).slice(-4).join(' > '),
      variantProperties: node.variantProperties || null,
      reactions: (node.reactions || []).map((reaction) => ({
        trigger: reaction.trigger,
        actionType: reaction.actionType,
        destinationFrameName: reaction.destinationFrameName,
      })),
    }));

  const frameTransitions = dedupeBy(
    (flowGraph?.edges || [])
      .filter((edge) => edge.sourceFrameName !== edge.destinationFrameName || !edge.destinationFrameName)
      .map((edge) => ({
        sourceFrameName: edge.sourceFrameName,
        sourceNodeName: edge.sourceNodeName,
        trigger: edge.trigger,
        actionType: edge.actionType,
        destinationFrameName: edge.destinationFrameName,
      })),
    (edge) =>
      [
        edge.sourceFrameName,
        edge.sourceNodeName,
        edge.trigger,
        edge.actionType,
        edge.destinationFrameName || 'NULL',
      ].join('|')
  ).slice(0, 80);

  const danglingReactions = frameTransitions.filter((edge) => !edge.destinationFrameName);

  return {
    frameCount: (flowGraph?.frames || []).length,
    nodeCount: (flowGraph?.nodes || []).length,
    edgeCount: (flowGraph?.edges || []).length,
    frames: (flowGraph?.frames || []).map((frame) => ({
      name: frame.name,
      size: `${Math.round(frame.width)}x${Math.round(frame.height)}`,
    })),
    frameTransitions,
    interactiveNodes,
    danglingReactions,
  };
}

export function inspectSelectedFlow({ flowGraph, decisionCard = null, visuals = [] }) {
  const graphSummary = summarizeFlowGraph(flowGraph);
  const frameNames = graphSummary.frames.map((frame) => frame.name);

  return {
    decisionCard,
    frameNames,
    graphSummary,
    visualFrameNames: (visuals || []).map((visual) => visual.name),
    diagnostics: {
      danglingReactionCount: graphSummary.danglingReactions.length,
      interactiveNodeCount: graphSummary.interactiveNodes.length,
      transitionCount: graphSummary.frameTransitions.length,
    },
  };
}

export function summarizeDesignVariables(designVariables) {
  if (!Array.isArray(designVariables) || designVariables.length === 0) {
    return null;
  }
  return designVariables.map((collection) => ({
    collection: collection.collection,
    tokens: (collection.tokens || []).slice(0, 60).map((token) => {
      let displayValue = token.value;
      if (token.resolvedType === 'COLOR' && displayValue && typeof displayValue === 'object') {
        const { r, g, b, a } = displayValue;
        displayValue = `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a !== undefined ? Math.round(a * 100) / 100 : 1})`;
      }
      return {
        name: token.name,
        type: token.resolvedType,
        value: displayValue,
        scopes: token.scopes,
      };
    }),
  }));
}

export function extractAvailableFrameNames(source) {
  if (!source) {
    return [];
  }

  if (Array.isArray(source)) {
    return source.map((value) => String(value || '').trim()).filter(Boolean);
  }

  if (source.flowGraph?.frames) {
    return source.flowGraph.frames.map((frame) => String(frame.name || '').trim()).filter(Boolean);
  }

  if (source.graphSummary?.frames) {
    return source.graphSummary.frames.map((frame) => String(frame.name || '').trim()).filter(Boolean);
  }

  return [];
}

export function selectVisualsForAudit(visuals, provider) {
  const maxVisuals = provider === 'openai' ? MAX_OPENAI_VISUALS : MAX_ANTHROPIC_VISUALS;
  return (visuals || []).slice(0, maxVisuals);
}

export function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) {
      throw new Error('Model response did not contain valid JSON.');
    }
    return JSON.parse(match[0]);
  }
}

export async function parseErrorResponse(response, provider) {
  let details = '';

  try {
    const data = await response.json();
    details = data?.error?.message || data?.message || data?.error?.type || '';
  } catch (_error) {
    try {
      details = await response.text();
    } catch (_nestedError) {
      details = '';
    }
  }

  const suffix = details ? `: ${details}` : '';
  return `${provider} request failed (${response.status})${suffix}`;
}

export async function callOpenAIWithRetry(request) {
  const retryableStatuses = new Set([408, 409, 429, 500, 502, 503, 504]);
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', request);
    if (response.ok) {
      return response;
    }

    if (!retryableStatuses.has(response.status) || attempt === maxAttempts) {
      const message = await parseErrorResponse(response, 'OpenAI');
      throw new Error(message);
    }

    const retryAfter = Number(response.headers.get('retry-after') || '0');
    const backoffMs = retryAfter > 0 ? retryAfter * 1000 : attempt * 1500;
    await delay(backoffMs);
  }

  throw new Error('OpenAI request failed after multiple retry attempts.');
}

export async function callLLM({ provider, model, apiKey, purpose, prompt, visuals }) {
  if (!apiKey) {
    throw new Error('Please provide an API key first.');
  }

  if (!model) {
    throw new Error('Please enter a model name.');
  }

  if (provider === 'openai') {
    const userContent = [{ type: 'text', text: prompt }];
    for (const visual of visuals || []) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${visual.base64}` },
      });
    }

    const response = await callOpenAIWithRetry({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: purpose },
          { role: 'user', content: userContent },
        ],
        max_completion_tokens: 1800,
        temperature: 0.3,
      }),
    });

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '{}';
  }

  const anthropicContent = [{ type: 'text', text: prompt }];
  for (const visual of visuals || []) {
    anthropicContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: visual.base64,
      },
    });
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1800,
      system: purpose,
      messages: [{ role: 'user', content: anthropicContent }],
    }),
  });

  if (!response.ok) {
    const message = await parseErrorResponse(response, 'Anthropic');
    throw new Error(message);
  }

  const data = await response.json();
  const textBlock = (data.content || []).find((item) => item.type === 'text');
  return textBlock?.text || '{}';
}

async function translateToZh({ provider, model, apiKey, source }) {
  // OpenAI json_object mode requires a root object, not an array.
  // Wrap arrays so the response is always a root object, then unwrap.
  const isArray = Array.isArray(source);
  const payload = isArray ? { items: source } : source;
  const raw = await callLLM({
    provider,
    model,
    apiKey,
    purpose: 'You are a professional translator. Translate every string value in the given JSON to Simplified Chinese (简体中文). Preserve the exact JSON structure and all keys. Return only valid JSON, no commentary.',
    prompt: `Translate to Simplified Chinese:\n${JSON.stringify(payload, null, 2)}`,
    visuals: [],
  });
  const parsed = extractJson(raw);
  if (isArray) {
    return Array.isArray(parsed.items) ? parsed.items : (Array.isArray(parsed) ? parsed : []);
  }
  return parsed;
}

export async function extractDecisionCard({ provider, model, apiKey, notes, language }) {
  const systemPrompt = [
    'You convert messy product notes into a strict JSON DecisionCard.',
    'Return only valid JSON with exactly these keys:',
    'decisionQuestion (string), businessGoal (string), businessMetrics (string[]), experienceGoal (string), experienceMetrics (string[]), drivingLogic (string), primaryMetric (string), guardrails (string[]), constraints (string[]).',
    'businessGoal: one sentence — what business outcome + which metric + direction (e.g. "Increase activation rate ↑20%, growth category").',
    'businessMetrics: array of quantified metric names with ↑/↓ direction where derivable from notes.',
    'experienceGoal: one sentence — which user behavior to optimize + experience metric (e.g. "Reduce task completion time ↓30%, increase completion rate ↑20%").',
    'experienceMetrics: array of experience metric names.',
    'drivingLogic: plain language causal chain a non-PM could understand — user behavior change → business outcome change. Must show the mechanism, not jargon.',
    'guardrails and constraints must be arrays of concise strings.',
    'Do not add markdown or commentary.',
  ].join(' ');

  const raw = await callLLM({
    provider,
    model,
    apiKey,
    purpose: systemPrompt,
    prompt: `Raw meeting notes:\n${notes}`,
    visuals: [],
  });

  const card = extractJson(raw);
  const result = {
    decisionQuestion:  card.decisionQuestion  || '',
    businessGoal:      card.businessGoal      || '',
    businessMetrics:   Array.isArray(card.businessMetrics)   ? card.businessMetrics   : [],
    experienceGoal:    card.experienceGoal    || '',
    experienceMetrics: Array.isArray(card.experienceMetrics) ? card.experienceMetrics : [],
    drivingLogic:      card.drivingLogic      || '',
    primaryMetric:     card.primaryMetric     || '',
    guardrails:        Array.isArray(card.guardrails)        ? card.guardrails        : [],
    constraints:       Array.isArray(card.constraints)       ? card.constraints       : [],
  };

  if (language === 'zh') {
    const translated = await translateToZh({ provider, model, apiKey, source: result });
    return {
      decisionQuestion:  translated.decisionQuestion  || result.decisionQuestion,
      businessGoal:      translated.businessGoal      || result.businessGoal,
      businessMetrics:   Array.isArray(translated.businessMetrics)   ? translated.businessMetrics   : result.businessMetrics,
      experienceGoal:    translated.experienceGoal    || result.experienceGoal,
      experienceMetrics: Array.isArray(translated.experienceMetrics) ? translated.experienceMetrics : result.experienceMetrics,
      drivingLogic:      translated.drivingLogic      || result.drivingLogic,
      primaryMetric:     translated.primaryMetric     || result.primaryMetric,
      guardrails:        Array.isArray(translated.guardrails)        ? translated.guardrails        : result.guardrails,
      constraints:       Array.isArray(translated.constraints)       ? translated.constraints       : result.constraints,
    };
  }

  return result;
}

export async function runContextualAudit({ provider, model, apiKey, payload, language }) {
  const flowInspection = inspectSelectedFlow(payload);
  const summarizedGraph = flowInspection.graphSummary;
  const selectedVisuals = selectVisualsForAudit(payload.visuals, provider);
  const omittedVisualNames = (payload.visuals || []).slice(selectedVisuals.length).map((item) => item.name);
  const variableSummary = summarizeDesignVariables(payload.designVariables);

  const systemPrompt = [
    'You are an interrogative UX Director.',
    'Cross-reference the attached visuals with the Logic Graph summary to find broken links, dead ends, and missing states.',
    'Critique the flow strictly against the provided Guardrails, Constraints, and business/experience metrics in the DecisionCard.',
    'Do not suggest removing friction if that friction serves a business constraint.',
    'Return only valid JSON in this exact shape:',
    '{"audits":[{',
    '"targetFrameName":"string",',
    '"critiqueType":"Broken Link | Missing State | Guardrail Conflict | Constraint Risk | Flow Ambiguity",',
    '"severity":"critical | warning | suggestion",',
    '"impactedMetric":"which business or experience metric this issue affects, with ↑/↓ direction (e.g. \'completion rate ↓\'). Must reference a metric from the DecisionCard businessMetrics or experienceMetrics where possible.",',
    '"causalMechanism":"[UI condition] → [user cognitive/behavioral response] → [metric consequence]. 1-2 sentences. No vague claims.",',
    '"guardrailRef":"exact guardrail string from DecisionCard, or null if not applicable",',
    '"suggestion":"one concrete actionable fix",',
    '"provocativeQuestion":"string"',
    '}]}',
    'severity rules: critical=user cannot complete their goal or a guardrail is violated; warning=significant friction or ambiguity; suggestion=improvement opportunity.',
  ].join(' ');

  const userPrompt = [
    'Evaluate the following tri-modal payload.',
    '',
    `DecisionCard:\n${JSON.stringify(payload.decisionCard, null, 2)}`,
    '',
    `FlowGraphSummary:\n${JSON.stringify(summarizedGraph, null, 2)}`,
    '',
    `Attached Visual Frames:\n${selectedVisuals.map((item) => item.name).join(', ') || 'None'}`,
    '',
    `Frames Without Attached Visuals Due To Token Budget:\n${omittedVisualNames.join(', ') || 'None'}`,
    '',
    variableSummary
      ? `Design Tokens (Figma Variables):\n${JSON.stringify(variableSummary, null, 2)}\nWhen a guardrail or constraint relates to color, spacing, or typography, reference the exact token name (e.g. $brand-danger) in guardrailRef where applicable.`
      : 'Design Tokens: none available for this file.',
    '',
    'Every critique must target one of the provided frame names exactly.',
    'If a frame is not visually attached, rely on the graph summary and business context instead of inventing UI details.',
  ].join('\n');

  const raw = await callLLM({
    provider,
    model,
    apiKey,
    purpose: systemPrompt,
    prompt: userPrompt,
    visuals: selectedVisuals,
  });

  const parsed = extractJson(raw);
  const rawAudits = Array.isArray(parsed.audits) ? parsed.audits : [];
  if (!rawAudits.length) {
    throw new Error('The model returned no audits.');
  }

  let audits = resolveFrameIds(rawAudits, payload.flowGraph);

  if (language === 'zh') {
    const translatableFields = audits.map((a) => ({
      critiqueType:        a.critiqueType,
      impactedMetric:      a.impactedMetric,
      causalMechanism:     a.causalMechanism,
      guardrailRef:        a.guardrailRef,
      suggestion:          a.suggestion,
      provocativeQuestion: a.provocativeQuestion,
    }));
    const translated = await translateToZh({ provider, model, apiKey, source: translatableFields });
    const translatedArr = Array.isArray(translated) ? translated : [];
    audits = audits.map((a, i) => ({
      ...a,
      critiqueType:        translatedArr[i]?.critiqueType        || a.critiqueType,
      impactedMetric:      translatedArr[i]?.impactedMetric      || a.impactedMetric,
      causalMechanism:     translatedArr[i]?.causalMechanism     || a.causalMechanism,
      guardrailRef:        translatedArr[i]?.guardrailRef        || a.guardrailRef,
      suggestion:          translatedArr[i]?.suggestion          || a.suggestion,
      provocativeQuestion: translatedArr[i]?.provocativeQuestion || a.provocativeQuestion,
    }));
  }

  const score = calculateAuditScore(audits);

  return {
    audits,
    score,
    meta: {
      attachedVisualFrames: selectedVisuals.map((item) => item.name),
      omittedVisualFrames: omittedVisualNames,
      graphSummary: summarizedGraph,
      flowInspection,
    },
  };
}

export async function generateEvidenceReport({ provider, model, apiKey, audits, decisionCard }) {
  // Cap at 20 items to stay within token budget
  const cappedAudits = (audits || []).slice(0, 20);
  const systemPrompt = 'You are a senior UX researcher and data analysis expert. Reconstruct a realistic UX research process that would have discovered and validated the provided issues. Output only valid JSON matching the requested schema. No markdown or commentary.';
  const userPrompt = [
    'UX AUDIT FINDINGS:',
    JSON.stringify(cappedAudits, null, 2),
    '',
    'DECISION CARD CONTEXT:',
    JSON.stringify(decisionCard, null, 2),
    '',
    'INSTRUCTIONS:',
    'Read ALL issues first. Identify shared patterns and root causes, then plan 1-2 research modules that cover all issues together. Do NOT treat each issue as a separate study.',
    '',
    'Return JSON with this exact structure:',
    JSON.stringify({
      issueOverview: { issueSummary: 'string', sharedPatterns: 'string', rootCauses: 'string', modulesCoverage: 'string' },
      hypotheses: [{ id: 'H1', statement: 'string', mechanism: 'string', testable: 'string' }],
      researchDesign: {
        moduleA: { method: 'string', sampleSize: 'string', segments: 'string', tasks: 'string', issuesCovered: 'string', whyQualitative: 'string' },
        moduleB: { method: 'string', timeRange: 'string', sampleSize: 'string', metrics: 'string', analysisDimensions: 'string', issuesCovered: 'string', whyQuantitative: 'string' },
      },
      results: {
        moduleA: { sampleBreakdown: 'string', keyFindings: ['string'], severityRatings: 'string', hypothesesSupported: 'string', suggestedVisualizations: ['string'] },
        moduleB: { sampleSize: 'string', coreMetrics: ['string'], hypothesesSupported: 'string', suggestedVisualizations: ['string'] },
      },
      issueDefinitions: [{ auditIndex: 0, definition: 'In [user + context], because of [design problem], users [behavioral consequence], which impacts [business metric].' }],
      userInsights: [{ auditIndex: 0, insight: 'string', cognitiveOrBehavioralMechanism: 'string', designImplication: 'string' }],
    }),
  ].join('\n');

  const raw = await callLLM({ provider, model, apiKey, purpose: systemPrompt, prompt: userPrompt, visuals: [] });
  return extractJson(raw);
}

export async function generateDRD({ provider, model, apiKey, audit, decisionCard }) {
  const systemPrompt = 'You are a senior Product Manager, Interaction Design expert, and UX Strategy consultant. Output only valid JSON matching the requested schema. No markdown or commentary.';
  const userPrompt = [
    'ISSUE:',
    `Frame: ${audit.targetFrameName || ''}`,
    `Critique type: ${audit.critiqueType || ''}`,
    `Severity: ${audit.severity || ''}`,
    `Problem: ${audit.suggestion || ''}`,
    `Impacted metric: ${audit.impactedMetric || 'unknown'}`,
    `Why it matters: ${audit.causalMechanism || ''}`,
    '',
    'BUSINESS CONTEXT:',
    JSON.stringify(decisionCard, null, 2),
    '',
    'Generate exactly 3 redesign solutions, then produce a DRD for the recommended one.',
    'Return JSON with this exact structure:',
    JSON.stringify({
      solutions: [{
        name: 'string',
        coreDirection: 'string',
        coreApproach: 'string',
        specificChanges: { informationArchitecture: 'string', interactionPath: 'string', visualHierarchy: 'string', keyElements: 'string' },
        beforeAfter: { before: 'string', after: 'string' },
        whyBetter: 'string',
        impactOnMetric: 'string',
      }],
      comparisonTable: [{ solution: 'string', suitableFor: 'string', scopeOfChange: 'string', risk: 'string', businessBenefit: 'string', timelineFit: 'string' }],
      recommendedIndex: 0,
      drd: {
        background: { currentProblem: 'string', rootCause: 'string', businessImpact: 'string' },
        goals: { experienceProblems: ['string'], businessMetrics: ['string'] },
        strategy: { coreApproach: 'string', rationale: 'string' },
        detailedRedesign: [{ module: 'string', whatChanges: 'string', why: 'string', userPerception: 'string', businessEffect: 'string' }],
        risksAndValidation: { sideEffects: ['string'], metricsToMonitor: ['string'], validationMethod: 'string' },
      },
    }),
  ].join('\n');

  const raw = await callLLM({ provider, model, apiKey, purpose: systemPrompt, prompt: userPrompt, visuals: [] });
  return extractJson(raw);
}

export function prepareWriteAuditFeedback({ audits, availableFrameNames = [] }) {
  if (!Array.isArray(audits) || audits.length === 0) {
    throw new Error('write_audit_feedback requires a non-empty audits array.');
  }

  const frameSet = new Set(availableFrameNames || []);
  const normalizedAudits = audits.map((audit, index) => {
    const targetFrameName = String(audit?.targetFrameName || '').trim();
    const critiqueType = String(audit?.critiqueType || 'Flow Ambiguity').trim();
    const provocativeQuestion = String(audit?.provocativeQuestion || '').trim();

    if (!targetFrameName) {
      throw new Error(`Audit item ${index + 1} is missing targetFrameName.`);
    }

    if (!provocativeQuestion) {
      throw new Error(`Audit item ${index + 1} is missing provocativeQuestion.`);
    }

    return {
      targetFrameName,
      critiqueType,
      provocativeQuestion,
      targetFrameExists: frameSet.size > 0 ? frameSet.has(targetFrameName) : null,
    };
  });

  return {
    audits: normalizedAudits,
    unresolvedTargets: normalizedAudits
      .filter((audit) => audit.targetFrameExists === false)
      .map((audit) => audit.targetFrameName),
    pluginMessage: {
      type: 'write-audit-feedback',
      audits: normalizedAudits.map(({ targetFrameExists: _targetFrameExists, ...audit }) => audit),
    },
  };
}
