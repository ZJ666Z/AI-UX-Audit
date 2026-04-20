import { stdin, stdout } from 'node:process';
import {
  extractAvailableFrameNames,
  extractDecisionCard,
  generateDRD,
  generateEvidenceReport,
  inspectSelectedFlow,
  prepareWriteAuditFeedback,
  runContextualAudit,
  summarizeDesignVariables,
} from './core.mjs';

const SERVER_INFO = {
  name: 'ai-ux-audit-mcp',
  version: '0.1.0',
};
const BRIDGE_HTTP_URL = process.env.BRIDGE_HTTP_URL || 'http://localhost:3845';

const TOOL_DEFINITIONS = [
  {
    name: 'extract_decision_card',
    description:
      'Convert raw meeting notes into a structured DecisionCard with decisionQuestion, primaryMetric, guardrails, and constraints.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['openai', 'anthropic'] },
        model: { type: 'string' },
        apiKey: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['provider', 'model', 'apiKey', 'notes'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_contextual_audit',
    description:
      'Evaluate a tri-modal UX audit payload containing DecisionCard, FlowGraph, and exported frame visuals, then return audit questions. Accepts either payload directly or sessionId from the running plugin bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        provider: { type: 'string', enum: ['openai', 'anthropic'] },
        model: { type: 'string' },
        apiKey: { type: 'string' },
        payload: {
          type: 'object',
          properties: {
            decisionCard: { type: 'object' },
            flowGraph: { type: 'object' },
            visuals: { type: 'array' },
          },
          required: ['decisionCard', 'flowGraph', 'visuals'],
          additionalProperties: true,
        },
      },
      required: ['provider', 'model', 'apiKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_selected_flow',
    description:
      'Summarize a selected Figma flow graph into frame transitions, dangling reactions, and other audit-friendly diagnostics. Accepts either flowGraph directly or sessionId from the running plugin bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        decisionCard: { type: 'object' },
        flowGraph: { type: 'object' },
        visuals: { type: 'array' },
      },
      required: [],
      additionalProperties: true,
    },
  },
  {
    name: 'get_variable_defs',
    description:
      'Retrieve Figma design tokens (variables) from the active plugin session and return a summarized, audit-friendly representation. Useful before running run_contextual_audit to understand available color, spacing, and typography tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_drd',
    description:
      'Generate 3 redesign solutions and a full DRD document for a specific audit finding. Accepts the audit item directly or identifies it by sessionId + auditItemIndex.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        auditItemIndex: { type: 'number' },
        provider: { type: 'string', enum: ['openai', 'anthropic'] },
        model: { type: 'string' },
        apiKey: { type: 'string' },
        audit: { type: 'object' },
        decisionCard: { type: 'object' },
      },
      required: ['provider', 'model', 'apiKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_evidence_report',
    description:
      'Generate a structured UX research evidence report from existing audit findings. Simulates the qualitative and quantitative research modules that would have discovered and validated the issues. Accepts either audits + decisionCard directly or sessionId from the running plugin bridge.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        provider: { type: 'string', enum: ['openai', 'anthropic'] },
        model: { type: 'string' },
        apiKey: { type: 'string' },
        audits: { type: 'array' },
        decisionCard: { type: 'object' },
      },
      required: ['provider', 'model', 'apiKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_audit_feedback',
    description:
      'Validate and normalize UX audit items, then return a pluginMessage payload that can be sent back to the Figma plugin for canvas write-back. If sessionId is provided, enqueue the message to the active plugin session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        audits: { type: 'array' },
        availableFrameNames: { type: 'array', items: { type: 'string' } },
      },
      required: ['audits'],
      additionalProperties: false,
    },
  },
];

function writeMessage(message) {
  const json = JSON.stringify(message);
  const content = Buffer.from(json, 'utf8');
  stdout.write(`Content-Length: ${content.length}\r\n\r\n`);
  stdout.write(content);
}

function makeTextResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function makeError(code, message, id = null) {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
}

async function fetchBridgeJson(path, options = {}) {
  const response = await fetch(`${BRIDGE_HTTP_URL}${path}`, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `Bridge HTTP request failed (${response.status}).`);
  }
  return payload;
}

async function getSessionContext(sessionId) {
  const payload = await fetchBridgeJson(`/api/session/context?sessionId=${encodeURIComponent(sessionId)}`);
  return payload;
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
      },
    };
  }

  if (method === 'notifications/initialized') {
    return null;
  }

  if (method === 'ping') {
    return {
      jsonrpc: '2.0',
      id,
      result: {},
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOL_DEFINITIONS,
      },
    };
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments || {};

    if (toolName === 'extract_decision_card') {
      const result = await extractDecisionCard(args);
      return {
        jsonrpc: '2.0',
        id,
        result: makeTextResult({ decisionCard: result }),
      };
    }

    if (toolName === 'run_contextual_audit') {
      let auditArgs = args;
      if (!auditArgs.payload && auditArgs.sessionId) {
        const sessionPayload = await getSessionContext(auditArgs.sessionId);
        if (!sessionPayload.auditPayload) {
          throw new Error('The session does not have an audit payload yet. Run Start Audit in the plugin first.');
        }
        auditArgs = {
          ...auditArgs,
          payload: sessionPayload.auditPayload,
        };
      }

      if (!auditArgs.payload) {
        throw new Error('run_contextual_audit requires either payload or sessionId.');
      }

      const result = await runContextualAudit(auditArgs);

      if (args.sessionId) {
        await fetchBridgeJson('/api/session/record-audit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: args.sessionId,
            score: result.score,
            audits: result.audits,
          }),
        }).catch(() => {});
      }

      return {
        jsonrpc: '2.0',
        id,
        result: makeTextResult({
          ...result,
          sessionId: args.sessionId || null,
        }),
      };
    }

    if (toolName === 'get_variable_defs') {
      const sessionPayload = await getSessionContext(args.sessionId);
      const rawVariables = sessionPayload?.auditPayload?.designVariables || [];
      const summary = summarizeDesignVariables(rawVariables);
      return {
        jsonrpc: '2.0',
        id,
        result: makeTextResult({
          sessionId: args.sessionId,
          hasVariables: Boolean(summary && summary.length > 0),
          variableSummary: summary || [],
          collectionCount: (summary || []).length,
          totalTokenCount: (summary || []).reduce((sum, c) => sum + c.tokens.length, 0),
        }),
      };
    }

    if (toolName === 'inspect_selected_flow') {
      let inspectArgs = args;
      if (!inspectArgs.flowGraph && inspectArgs.sessionId) {
        const sessionPayload = await getSessionContext(inspectArgs.sessionId);
        if (!sessionPayload.auditPayload) {
          throw new Error('The session does not have an audit payload yet. Run Start Audit in the plugin first.');
        }
        inspectArgs = sessionPayload.auditPayload;
      }

      if (!inspectArgs.flowGraph) {
        throw new Error('inspect_selected_flow requires either flowGraph or sessionId.');
      }

      const result = inspectSelectedFlow(inspectArgs);
      return {
        jsonrpc: '2.0',
        id,
        result: makeTextResult(result),
      };
    }

    if (toolName === 'generate_drd') {
      let { audit, decisionCard } = args;
      if (!audit && args.sessionId) {
        const sessionPayload = await getSessionContext(args.sessionId);
        const audits = sessionPayload?.auditPayload?.audits || sessionPayload?.audits || [];
        const idx = args.auditItemIndex ?? 0;
        audit = audits[idx];
        decisionCard = decisionCard || sessionPayload?.auditPayload?.decisionCard;
        if (!audit) throw new Error(`No audit item at index ${idx} in session.`);
      }
      if (!audit) throw new Error('generate_drd requires either audit object or sessionId + auditItemIndex.');
      const result = await generateDRD({ ...args, audit, decisionCard });
      return { jsonrpc: '2.0', id, result: makeTextResult(result) };
    }

    if (toolName === 'generate_evidence_report') {
      let { audits, decisionCard } = args;
      if ((!audits || !audits.length) && args.sessionId) {
        const sessionPayload = await getSessionContext(args.sessionId);
        if (!sessionPayload.auditPayload) {
          throw new Error('The session does not have an audit payload yet. Run Start Audit in the plugin first.');
        }
        audits = sessionPayload.auditPayload.audits || sessionPayload.audits || [];
        decisionCard = decisionCard || sessionPayload.auditPayload.decisionCard;
      }
      if (!audits || !audits.length) {
        throw new Error('generate_evidence_report requires either audits array or sessionId with recorded audits.');
      }
      const result = await generateEvidenceReport({ ...args, audits, decisionCard });
      return { jsonrpc: '2.0', id, result: makeTextResult(result) };
    }

    if (toolName === 'write_audit_feedback') {
      let availableFrameNames = args.availableFrameNames;
      if ((!availableFrameNames || availableFrameNames.length === 0) && args.sessionId) {
        const sessionPayload = await getSessionContext(args.sessionId);
        availableFrameNames = extractAvailableFrameNames(sessionPayload.auditPayload);
      }

      const result = prepareWriteAuditFeedback({
        audits: args.audits,
        availableFrameNames,
      });

      let enqueueStatus = null;
      if (args.sessionId) {
        enqueueStatus = await fetchBridgeJson('/api/session/enqueue-plugin-message', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            sessionId: args.sessionId,
            pluginMessage: result.pluginMessage,
          }),
        });
      }

      return {
        jsonrpc: '2.0',
        id,
        result: makeTextResult({
          ...result,
          sessionId: args.sessionId || null,
          enqueuedToSession: Boolean(enqueueStatus),
        }),
      };
    }

    return makeError(-32602, `Unknown tool: ${toolName}`, id);
  }

  return makeError(-32601, `Method not found: ${method}`, id);
}

let buffer = Buffer.alloc(0);

stdin.on('data', async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return;
    }

    const headerText = buffer.slice(0, headerEnd).toString('utf8');
    const headers = new Map();
    for (const line of headerText.split('\r\n')) {
      const separator = line.indexOf(':');
      if (separator === -1) {
        continue;
      }
      headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }

    const contentLength = Number(headers.get('content-length') || '0');
    const messageEnd = headerEnd + 4 + contentLength;
    if (buffer.length < messageEnd) {
      return;
    }

    const body = buffer.slice(headerEnd + 4, messageEnd).toString('utf8');
    buffer = buffer.slice(messageEnd);

    let message;
    try {
      message = JSON.parse(body);
    } catch (_error) {
      writeMessage(makeError(-32700, 'Parse error'));
      continue;
    }

    try {
      const response = await handleRequest(message);
      if (response) {
        writeMessage(response);
      }
    } catch (error) {
      writeMessage(makeError(-32000, error instanceof Error ? error.message : 'Unknown MCP server error.', message?.id ?? null));
    }
  }
});

stdin.resume();
