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

export async function callLLM({ provider, model, apiKey, purpose, prompt, visuals, maxTokens = 1800 }) {
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
        max_completion_tokens: maxTokens,
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
      max_tokens: maxTokens,
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
    'decisionQuestion (string), businessGoal (string), businessMetrics (string[]), experienceGoal (string), experienceMetrics (string[]), drivingLogic (string), primaryMetric (string), guardrails (string[]), constraints (string[]), touchpoints (string[]).',
    'businessGoal: one sentence — what business outcome + which metric + direction (e.g. "Increase activation rate ↑20%, growth category").',
    'businessMetrics: array of quantified metric names with ↑/↓ direction where derivable from notes.',
    'experienceGoal: one sentence — which user behavior to optimize + experience metric (e.g. "Reduce task completion time ↓30%, increase completion rate ↑20%").',
    'experienceMetrics: array of experience metric names.',
    'drivingLogic: plain language causal chain a non-PM could understand — user behavior change → business outcome change. Must show the mechanism, not jargon.',
    'touchpoints: array of device/platform context strings (e.g. ["TV (remote control)", "Mobile (touch)"]). Infer from notes if mentioned.',
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
    touchpoints:       Array.isArray(card.touchpoints)       ? card.touchpoints       : [],
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
      touchpoints:       Array.isArray(translated.touchpoints)       ? translated.touchpoints       : result.touchpoints,
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
    'You are a senior UX Director and product strategist. Your response has two mandatory sequential parts in a single JSON object.',
    '',
    'PART 1 — Business Analysis: Analyse the DecisionCard to surface what this flow is really trying to accomplish.',
    'Required fields:',
    '  coreAction: The single highest-value action a user must complete in this flow (string).',
    '  whyItMatters: Why completing that action directly moves the primary business metric — one sentence (string).',
    '  businessMetrics: Array of 3-5 objects, each with "metric" (string), "direction" ("↑" or "↓"), "segment" (string — user group most affected).',
    '  businessLogic: Plain-language causal chain: UI condition → user behavior → business outcome (string).',
    '  summary: 2-sentence synthesis connecting the coreAction to the top business metric (string).',
    '',
    'PART 2 — UX Issues: Cross-reference the attached visuals with the flow graph. Identify exactly 3–5 UX issues that most directly threaten the business metrics from Part 1.',
    'Sort items by business impact: critical first, then warning, then suggestion.',
    'Required fields for each item:',
    '  targetFrameName: exact frame name from the flow (string).',
    '  what: one-sentence plain-English label of the issue (string).',
    '  where: exact UI location — component name, screen zone, or element type (string).',
    '  critiqueType: "Broken Link" | "Missing State" | "Guardrail Conflict" | "Constraint Risk" | "Flow Ambiguity".',
    '  severity: "critical" | "warning" | "suggestion".',
    '  impactedMetric: metric with ↑/↓ direction, referencing DecisionCard metrics where possible (string).',
    '  why: why this issue blocks or degrades the coreAction — 1 sentence (string).',
    '  causalMechanism: [UI condition] → [user response] → [metric consequence]. 1-2 sentences (string).',
    '  guardrailRef: exact guardrail from DecisionCard if violated, else null.',
    '  suggestion: one concrete actionable fix (string).',
    '  provocativeQuestion: a sharp question a stakeholder should ask about this issue (string).',
    '',
    'If the DecisionCard includes touchpoints, evaluate interaction patterns specific to those devices (e.g. TV remote: focus management, D-pad navigation; Mobile: thumb zones, 44px tap targets).',
    'Do not suggest removing friction if that friction serves a business constraint.',
    'severity rules: critical=user cannot complete goal or guardrail violated; warning=significant friction or ambiguity; suggestion=improvement opportunity.',
    '',
    'Return ONLY valid JSON:',
    '{"businessAnalysis":{"coreAction":"string","whyItMatters":"string","businessMetrics":[{"metric":"string","direction":"↑ or ↓","segment":"string"}],"businessLogic":"string","summary":"string"},"auditItems":[{"targetFrameName":"string","what":"string","where":"string","critiqueType":"string","severity":"string","impactedMetric":"string","why":"string","causalMechanism":"string","guardrailRef":"string or null","suggestion":"string","provocativeQuestion":"string"}]}',
  ].join('\n');

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
  const rawAudits = Array.isArray(parsed.auditItems) ? parsed.auditItems
    : Array.isArray(parsed.audits) ? parsed.audits : [];
  if (!rawAudits.length) {
    throw new Error('The model returned no audits.');
  }

  let businessAnalysis = parsed.businessAnalysis || null;
  let audits = resolveFrameIds(rawAudits, payload.flowGraph);

  if (language === 'zh') {
    const translatableFields = audits.map((a) => ({
      what:                a.what,
      where:               a.where,
      why:                 a.why,
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
      what:                translatedArr[i]?.what                || a.what,
      where:               translatedArr[i]?.where               || a.where,
      why:                 translatedArr[i]?.why                 || a.why,
      critiqueType:        translatedArr[i]?.critiqueType        || a.critiqueType,
      impactedMetric:      translatedArr[i]?.impactedMetric      || a.impactedMetric,
      causalMechanism:     translatedArr[i]?.causalMechanism     || a.causalMechanism,
      guardrailRef:        translatedArr[i]?.guardrailRef        || a.guardrailRef,
      suggestion:          translatedArr[i]?.suggestion          || a.suggestion,
      provocativeQuestion: translatedArr[i]?.provocativeQuestion || a.provocativeQuestion,
    }));

    if (businessAnalysis) {
      const baSource = [{
        coreAction:      businessAnalysis.coreAction,
        whyItMatters:    businessAnalysis.whyItMatters,
        businessLogic:   businessAnalysis.businessLogic,
        summary:         businessAnalysis.summary,
      }];
      try {
        const baTranslated = await translateToZh({ provider, model, apiKey, source: baSource });
        const bt = Array.isArray(baTranslated) ? baTranslated[0] : null;
        if (bt) {
          businessAnalysis = {
            ...businessAnalysis,
            coreAction:    bt.coreAction    || businessAnalysis.coreAction,
            whyItMatters:  bt.whyItMatters  || businessAnalysis.whyItMatters,
            businessLogic: bt.businessLogic || businessAnalysis.businessLogic,
            summary:       bt.summary       || businessAnalysis.summary,
          };
        }
      } catch (_) { /* keep English */ }
    }
  }

  const score = calculateAuditScore(audits);

  return {
    audits,
    businessAnalysis,
    score,
    meta: {
      attachedVisualFrames: selectedVisuals.map((item) => item.name),
      omittedVisualFrames: omittedVisualNames,
      graphSummary: summarizedGraph,
      flowInspection,
    },
  };
}

const INTENTIONAL_EXIT_KEYWORDS_MJS = ['success', 'complete', 'done', 'confirm', 'thank', '成功', '完成', '确认', '谢谢'];

function isIntentionalExitMjs(name) {
  const lower = name.toLowerCase();
  return INTENTIONAL_EXIT_KEYWORDS_MJS.some((kw) => lower.includes(kw.toLowerCase()));
}

export function computeGraphMetrics(flowGraph) {
  const { frames, nodes, edges } = flowGraph;

  const outboundNeighbors = new Map();
  const inboundNeighbors  = new Map();
  const danglingByFrame   = new Map();
  for (const frame of frames) {
    outboundNeighbors.set(frame.name, new Set());
    inboundNeighbors.set(frame.name, new Set());
    danglingByFrame.set(frame.name, 0);
  }
  for (const edge of edges) {
    const src = edge.sourceFrameName;
    const dst = edge.destinationFrameName;
    if (dst === null) {
      danglingByFrame.set(src, (danglingByFrame.get(src) ?? 0) + 1);
    } else if (dst !== src) {
      outboundNeighbors.get(src)?.add(dst);
      inboundNeighbors.get(dst)?.add(src);
    }
  }
  const interactiveByFrame = new Map();
  for (const frame of frames) interactiveByFrame.set(frame.name, 0);
  for (const node of nodes) {
    if (node.isInteractive) interactiveByFrame.set(node.frameName, (interactiveByFrame.get(node.frameName) ?? 0) + 1);
  }

  const frameMetrics = frames.map((frame) => {
    const outbound = outboundNeighbors.get(frame.name) ?? new Set();
    const inbound  = inboundNeighbors.get(frame.name) ?? new Set();
    const dangling = danglingByFrame.get(frame.name) ?? 0;
    const outboundCount = outbound.size;
    const inboundCount  = inbound.size;
    const isEntryPoint = inboundCount === 0;
    const isExitPoint  = outboundCount === 0;
    return {
      frameId: frame.id, frameName: frame.name,
      inboundCount, outboundCount, danglingReactions: dangling,
      isEntryPoint, isExitPoint,
      isDeadEnd: isExitPoint && !isIntentionalExitMjs(frame.name),
      interactiveNodeCount: interactiveByFrame.get(frame.name) ?? 0,
      decisionPointCount: outboundCount > 1 ? 1 : 0,
      frameArea: frame.width * frame.height,
    };
  });

  const entryPoints = frameMetrics.filter((f) => f.isEntryPoint).map((f) => f.frameName);
  const exitPoints  = frameMetrics.filter((f) => f.isExitPoint).map((f) => f.frameName);
  const deadEnds    = frameMetrics.filter((f) => f.isDeadEnd).map((f) => f.frameName);
  const totalDecisionPoints    = frameMetrics.reduce((s, f) => s + f.decisionPointCount, 0);
  const totalDanglingReactions = frameMetrics.reduce((s, f) => s + f.danglingReactions, 0);
  const totalTransitions = edges.filter((e) => e.destinationFrameName !== null && e.destinationFrameName !== e.sourceFrameName).length;

  let mostConnectedFrame = frames[0]?.name ?? '';
  let mostConnectedCount = -1;
  let leastConnectedFrame = frames[0]?.name ?? '';
  let leastConnectedTotal = Infinity;
  for (const fm of frameMetrics) {
    if (fm.inboundCount > mostConnectedCount) { mostConnectedCount = fm.inboundCount; mostConnectedFrame = fm.frameName; }
    const t = fm.inboundCount + fm.outboundCount;
    if (t < leastConnectedTotal) { leastConnectedTotal = t; leastConnectedFrame = fm.frameName; }
  }

  const adjacency = new Map();
  for (const frame of frames) adjacency.set(frame.name, Array.from(outboundNeighbors.get(frame.name) ?? []));
  const deadEndSet = new Set(deadEnds);
  const allNames   = frames.map((f) => f.name);
  const startFrames = entryPoints.length > 0 ? entryPoints : allNames.slice(0, 1);

  let bestPath = [];
  function dfs(current, path, visited) {
    if (path.length >= frames.length) {
      if (!deadEndSet.has(current) && path.length > bestPath.length) bestPath = [...path];
      return;
    }
    const unvisited = (adjacency.get(current) || []).filter((n) => !visited.has(n));
    if (unvisited.length === 0) {
      if (!deadEndSet.has(current) && path.length > bestPath.length) bestPath = [...path];
      return;
    }
    for (const neighbor of unvisited) {
      visited.add(neighbor);
      dfs(neighbor, [...path, neighbor], visited);
      visited.delete(neighbor);
    }
  }
  for (const entry of startFrames) {
    const visited = new Set([entry]);
    dfs(entry, [entry], visited);
  }

  const happyPathExtra = Math.max(0, bestPath.length - 5);
  const cognitiveComplexityScore = Math.max(0,
    100 - totalDecisionPoints * 3 - deadEnds.length * 5 - totalDanglingReactions * 2 - happyPathExtra,
  );

  return {
    frameMetrics,
    flowMetrics: {
      totalFrames: frames.length, totalTransitions,
      entryPoints, exitPoints, deadEnds,
      mostConnectedFrame, leastConnectedFrame,
      totalDecisionPoints, totalDanglingReactions,
      happyPath: bestPath, cognitiveComplexityScore,
    },
  };
}

export function computeFlowHealthScore(flowMetrics) {
  if (!flowMetrics) return 100;
  let score = 100;
  const deadEndCount  = (flowMetrics.deadEnds || []).length;
  const danglingCount = flowMetrics.totalDanglingReactions || 0;
  if (deadEndCount > 0)  score -= Math.min(10 + 5 * Math.max(0, deadEndCount - 1), 20);
  if (danglingCount > 0) score -= Math.min(5  + 2 * Math.max(0, danglingCount - 1), 10);
  if ((flowMetrics.entryPoints || []).length > 1) score -= 5;
  if ((flowMetrics.cognitiveComplexityScore ?? 100) < 40) score -= 5;
  else if ((flowMetrics.cognitiveComplexityScore ?? 100) < 60) score -= 3;
  return Math.max(0, score);
}

export async function analyzeJourney({ provider, model, apiKey, flowGraph, flowMetrics, frameMetrics, decisionCard, existingAudits }) {
  // Allow caller to pass pre-computed metrics or compute them from the raw flow graph
  let fm = flowMetrics;
  let frm = frameMetrics;
  if (!fm && flowGraph) {
    const computed = computeGraphMetrics(flowGraph);
    fm  = computed.flowMetrics;
    frm = computed.frameMetrics;
  }
  const preScore = computeFlowHealthScore(fm);
  const totalFrames = (fm && fm.totalFrames) || 0;
  const filteredFrameMetrics = totalFrames > 20
    ? (frm || []).filter((f) => f.isDeadEnd || f.danglingReactions > 0 || f.decisionPointCount > 2 || f.inboundCount === 0)
    : (frm || []);

  const systemPrompt = 'You are a senior UX researcher and interaction design expert specializing in user flow analysis. Analyze the journey as a whole and output only valid JSON. No markdown or commentary.';
  const userPrompt = [
    'FLOW METRICS:', JSON.stringify(fm, null, 2),
    '', 'PER-FRAME METRICS:', JSON.stringify(filteredFrameMetrics, null, 2),
    '', 'DECISION CARD:', JSON.stringify(decisionCard, null, 2),
    '', 'EXISTING PER-FRAME AUDIT FINDINGS (do not repeat):', JSON.stringify((existingAudits || []).slice(0, 10), null, 2),
    '', 'Analyze the journey as a whole. Return JSON with keys: happyPathAssessment, dropOffPoints, flowStructureObservations, journeyScoreAdjustment.',
    'Happy path is: ' + JSON.stringify(fm && fm.happyPath),
    JSON.stringify({
      happyPathAssessment: { pathMakesSense: true, misplacedFrames: [], minimumSteps: 0, unnecessaryFriction: '', summary: '' },
      dropOffPoints: [{ frameName: '', severity: 'critical|warning', dropOffType: 'dead_end|decision_overload|isolation|navigation_trap', journeyPosition: 'early|mid|late', whyUsersLeave: '', impactOnGoal: '', suggestion: '' }],
      flowStructureObservations: [{ observation: '', affectedFrames: [], severity: 'critical|warning|suggestion', journeyImpact: '' }],
      journeyScoreAdjustment: { additionalDeductions: [{ reason: '', points: 8, severity: 'critical|warning' }], journeySummary: '' },
    }),
  ].join('\n');

  const raw = await callLLM({ provider, model, apiKey, purpose: systemPrompt, prompt: userPrompt, visuals: [], maxTokens: 3200 });
  const result = extractJson(raw);

  const adjustments = result.journeyScoreAdjustment && result.journeyScoreAdjustment.additionalDeductions;
  let postScore = preScore;
  for (const adj of adjustments || []) postScore = Math.max(0, postScore - (adj.points || 0));

  return {
    flowMetrics: fm,
    frameMetrics: frm,
    preScore,
    postScore,
    analysis: result,
  };
}

export async function generateEvidenceReport({ provider, model, apiKey, audits, decisionCard }) {
  const cappedAudits = (audits || []).slice(0, 20);
  const systemPrompt = 'You are a senior UX researcher. You design holistic research plans — not one study per issue. Output only valid JSON matching the requested schema. No markdown or commentary.';

  const userPrompt = [
    'UX AUDIT FINDINGS (read all together before planning):',
    JSON.stringify(cappedAudits.map((a, i) => ({ index: i, frameName: a.targetFrameName, what: a.what, severity: a.severity, impactedMetric: a.impactedMetric })), null, 2),
    '',
    'DECISION CARD:',
    JSON.stringify(decisionCard, null, 2),
    '',
    'INSTRUCTIONS — follow all 5 steps:',
    '',
    'Step 1 — Read ALL issues together. Identify what types of problems they are (cognition / behavior / information architecture / decision overload / trust / etc.), which issues share a root cause, and the minimum number of research modules needed.',
    '',
    'Step 2 — Design 1–2 research modules (NOT one per issue):',
    '  moduleA (Qualitative — answers "Why"): method (user interviews / think-aloud / contextual inquiry), issuesCovered (list), whyThisMethod (plain language), sampleSize (n=?), segments, tasks (interview guide outline), setting.',
    '  moduleB (Quantitative — answers "How many / Where"): method (funnel analysis / clickstream / heatmap / session recording / A/B test), issuesCovered, whyThisMethod, timeRange, sampleSize, coreMetrics, analysisDimensions.',
    '',
    'Step 3 — Simulated findings for each module (realistic, not fabricated):',
    '  Each finding must include a concrete number or percentage (e.g. "8 of 12 users hesitated at step 3", "drop-off rate: 34%"), a severity (Critical / Major / Minor), the hypothesis it supports or refutes, and a visualization suggestion.',
    '',
    'Step 4 — For each original audit issue, output:',
    '  issueDefinitions: "In [user + context], because of [design problem], users [behavior], which ultimately impacts [business metric]."',
    '  userInsights: evidence-based insight pointing to a cognitive or decision-making mechanism. NOT a restatement of the UI problem. Include designImplication.',
    '',
    'Step 5 — 2–4 research hypotheses covering the full issue set. Each must point to a user cognition, decision-making, or behavior mechanism, and be testable.',
    '',
    'Return ONLY valid JSON in this exact shape:',
    JSON.stringify({
      researchPlan: {
        problemTypes: 'string',
        rootCauseGroups: [{ groupName: 'string', issues: ['string'], sharedRootCause: 'string' }],
        modulesJustification: 'string',
      },
      hypotheses: [{ id: 'H1', statement: 'string', mechanism: 'string', testable: 'string' }],
      moduleA: {
        method: 'string',
        whyThisMethod: 'string',
        issuesCovered: ['string'],
        sampleSize: 'string',
        segments: 'string',
        tasks: 'string',
        setting: 'string',
        findings: [{ finding: 'string', severity: 'Critical | Major | Minor', hypothesisRef: 'H1', supported: true, visualization: 'string' }],
      },
      moduleB: {
        method: 'string',
        whyThisMethod: 'string',
        issuesCovered: ['string'],
        timeRange: 'string',
        sampleSize: 'string',
        coreMetrics: ['string'],
        analysisDimensions: ['string'],
        findings: [{ finding: 'string', severity: 'Critical | Major | Minor', hypothesisRef: 'H1', supported: true, visualization: 'string' }],
      },
      issueDefinitions: [{ auditIndex: 0, frameName: 'string', severity: 'string', definition: 'In [user + context], because of [design problem], users [behavior], which ultimately impacts [business metric].' }],
      userInsights: [{ auditIndex: 0, frameName: 'string', severity: 'string', insight: 'string', cognitiveOrBehavioralMechanism: 'string', designImplication: 'string' }],
    }),
  ].join('\n');

  const raw = await callLLM({ provider, model, apiKey, purpose: systemPrompt, prompt: userPrompt, visuals: [], maxTokens: 3200 });
  return extractJson(raw);
}

export async function generateDRD({ provider, model, apiKey, audit, decisionCard }) {
  const systemPrompt = 'You are a senior Product Manager, Interaction Design expert, and UX Strategy consultant. Output only valid JSON matching the requested schema. No markdown or commentary.';
  const userPrompt = [
    'ISSUE:',
    `Frame: ${audit.targetFrameName || ''}`,
    `Critique type: ${audit.critiqueType || ''}`,
    `Severity: ${audit.severity || ''}`,
    `Problem: ${audit.what || audit.suggestion || ''}`,
    `Where: ${audit.where || ''}`,
    `Impacted metric: ${audit.impactedMetric || 'unknown'}`,
    `Why it matters: ${audit.why || audit.causalMechanism || ''}`,
    '',
    'BUSINESS CONTEXT:',
    JSON.stringify(decisionCard, null, 2),
    '',
    'MANDATORY DIFFERENTIATION CONSTRAINT:',
    'Before generating the 3 solutions, declare upfront in dimensionDeclaration which design dimension each solution primarily targets:',
    '  Solution 1 must primarily address one of: information architecture / content hierarchy / interaction path',
    '  Solution 2 must primarily address one of: visual weight / affordance / feedback mechanisms',
    '  Solution 3 must primarily address one of: defaults / progressive disclosure / error prevention / copy and guidance',
    'These three dimensions must be different from each other. Solutions that address the same underlying dimension are not acceptable even if they look different.',
    '',
    'For each solution, the beforeAfter section must explicitly answer four questions:',
    '  before: What does the user see and what do they do in the current design?',
    '  after: What is the FIRST thing the user notices that is different — not the last, the first?',
    '  interactionPathChange: Which specific interaction path is shortened, removed, or restructured?',
    '  meaningfulChangeEvidence: Why would someone looking at before and after side by side immediately understand this is a meaningful change and not a cosmetic one?',
    '',
    'COMPARISON TABLE CONSTRAINT:',
    'The three solutions must differ in scope (one minimal/surgical, one medium, one structural), risk level, and implementation timeline. These differences must be immediately obvious from the table.',
    '',
    'Generate exactly 3 redesign solutions, then produce a DRD for the recommended one.',
    'Return JSON with this exact structure:',
    JSON.stringify({
      dimensionDeclaration: { solution1: 'string — chosen dimension', solution2: 'string — chosen dimension', solution3: 'string — chosen dimension' },
      solutions: [{
        name: 'string',
        dimension: 'string — the design dimension this solution primarily addresses',
        coreDirection: 'string',
        coreApproach: 'string',
        specificChanges: { informationArchitecture: 'string', interactionPath: 'string', visualHierarchy: 'string', keyElements: 'string' },
        beforeAfter: {
          before: 'string — what does the user see and what do they do?',
          after: 'string — what is the FIRST thing the user notices that is different?',
          interactionPathChange: 'string — which specific interaction path is shortened, removed, or restructured?',
          meaningfulChangeEvidence: 'string — why is this a meaningful change and not cosmetic?',
        },
        whyBetter: 'string',
        impactOnMetric: 'string',
      }],
      comparisonTable: [{ solution: 'string', dimension: 'string', suitableFor: 'string', scopeOfChange: 'Minimal/Surgical | Medium | Structural', risk: 'string', businessBenefit: 'string', timelineFit: 'string' }],
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

  const raw = await callLLM({ provider, model, apiKey, purpose: systemPrompt, prompt: userPrompt, visuals: [], maxTokens: 3500 });
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
