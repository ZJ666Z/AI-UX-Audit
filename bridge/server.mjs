import http from 'node:http';
import {
  extractAvailableFrameNames,
  extractDecisionCard,
  inspectSelectedFlow,
  prepareWriteAuditFeedback,
  runContextualAudit,
} from './core.mjs';
import { appendAuditHistory, readAuditHistory } from './history.mjs';
import {
  drainPluginMessages,
  enqueuePluginMessage,
  ensureSession,
  getSession,
  recordAuditResult,
  updateSessionContext,
} from './session-store.mjs';

const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 3845);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  response.end(JSON.stringify(payload));
}

function getSessionSnapshot(session) {
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    fileId: session.fileId || null,
    selectionInfo: session.selectionInfo,
    hasAuditPayload: Boolean(session.auditPayload),
    availableFrameNames: extractAvailableFrameNames(session.auditPayload),
    latestAuditScore: session.latestAuditScore,
    auditHistoryCount: (session.auditHistory || []).length,
    pendingPluginMessageCount: session.pendingPluginMessages.length,
  };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on('data', (chunk) => {
      chunks.push(chunk);
    });

    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });

    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  const url = new URL(request.url || '/', `http://${request.headers.host}`);

  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true, transport: 'http', bridge: 'ai-ux-audit' });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/session/register') {
      const body = await readJsonBody(request);
      const session = ensureSession(body.sessionId);
      sendJson(response, 200, { session: getSessionSnapshot(session) });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/session/update-context') {
      const body = await readJsonBody(request);
      const session = updateSessionContext(body.sessionId, {
        selectionInfo: body.selectionInfo,
        auditPayload: body.auditPayload,
      });
      sendJson(response, 200, { session: getSessionSnapshot(session) });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/session/context') {
      const sessionId = url.searchParams.get('sessionId');
      const session = getSession(sessionId);
      if (!session) {
        sendJson(response, 404, { error: 'Session not found.' });
        return;
      }
      sendJson(response, 200, {
        session: getSessionSnapshot(session),
        auditPayload: session.auditPayload,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/session/pending') {
      const sessionId = url.searchParams.get('sessionId');
      const messages = drainPluginMessages(sessionId);
      sendJson(response, 200, { messages });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/session/enqueue-plugin-message') {
      const body = await readJsonBody(request);
      const queued = enqueuePluginMessage(body.sessionId, body.pluginMessage);
      sendJson(response, 200, { queued });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/extract-decision-card') {
      const body = await readJsonBody(request);
      const decisionCard = await extractDecisionCard(body);
      sendJson(response, 200, { decisionCard });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/run-contextual-audit') {
      const body = await readJsonBody(request);
      const result = await runContextualAudit(body);

      if (body.sessionId) {
        const session = getSession(body.sessionId);
        const { entry, severityCounts } = recordAuditResult(body.sessionId, result);
        const fileId = session?.fileId || body.sessionId;
        appendAuditHistory(fileId, {
          sessionId: body.sessionId,
          score: result.score,
          severityCounts,
          auditCount: entry.auditCount,
          audits: result.audits,
        });
      }

      sendJson(response, 200, result);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/session/record-audit') {
      const body = await readJsonBody(request);
      const session = getSession(body.sessionId);
      if (!session) {
        sendJson(response, 404, { error: 'Session not found.' });
        return;
      }
      const { entry, severityCounts } = recordAuditResult(body.sessionId, body);
      const fileId = session.fileId || body.sessionId;
      appendAuditHistory(fileId, {
        sessionId: body.sessionId,
        score: body.score,
        severityCounts,
        auditCount: entry.auditCount,
        audits: body.audits,
      });
      sendJson(response, 200, { score: body.score, severityCounts, auditCount: entry.auditCount });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/session/score') {
      const sessionId = url.searchParams.get('sessionId');
      const session = getSession(sessionId);
      if (!session) {
        sendJson(response, 404, { error: 'Session not found.' });
        return;
      }
      const fileId = session.fileId || sessionId;
      sendJson(response, 200, {
        sessionId,
        latestAuditScore: session.latestAuditScore,
        auditHistory: session.auditHistory,
        historicalRuns: readAuditHistory(fileId),
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/inspect-selected-flow') {
      const body = await readJsonBody(request);
      const result = inspectSelectedFlow(body);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/write-audit-feedback') {
      const body = await readJsonBody(request);
      const result = prepareWriteAuditFeedback(body);
      if (body.sessionId) {
        enqueuePluginMessage(body.sessionId, result.pluginMessage);
      }
      sendJson(response, 200, result);
      return;
    }

    sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Unknown bridge error.',
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AI UX Audit bridge listening on http://${HOST}:${PORT}`);
});
