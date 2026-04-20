const SESSION_TTL_MS = 1000 * 60 * 60;

const sessions = new Map();

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
}

export function ensureSession(sessionId) {
  if (!sessionId) {
    throw new Error('sessionId is required.');
  }

  pruneExpiredSessions();

  const existing = sessions.get(sessionId);
  if (existing) {
    existing.updatedAt = Date.now();
    return existing;
  }

  const created = {
    sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    fileId: null,
    selectionInfo: null,
    auditPayload: null,
    latestAuditScore: null,
    auditHistory: [],
    pendingPluginMessages: [],
  };

  sessions.set(sessionId, created);
  return created;
}

export function updateSessionContext(sessionId, updates) {
  const session = ensureSession(sessionId);
  if (updates.fileId !== undefined) {
    session.fileId = updates.fileId;
  }
  if (updates.selectionInfo !== undefined) {
    session.selectionInfo = updates.selectionInfo;
  }
  if (updates.auditPayload !== undefined) {
    session.auditPayload = updates.auditPayload;
  }
  session.updatedAt = Date.now();
  return session;
}

export function recordAuditResult(sessionId, { score, audits }) {
  const session = ensureSession(sessionId);
  const severityCounts = { critical: 0, warning: 0, suggestion: 0 };
  for (const audit of audits || []) {
    if (audit.severity in severityCounts) {
      severityCounts[audit.severity] += 1;
    }
  }
  const entry = {
    timestamp: Date.now(),
    score,
    severityCounts,
    auditCount: (audits || []).length,
  };
  session.latestAuditScore = score;
  session.auditHistory.push(entry);
  session.updatedAt = Date.now();
  return { session, entry, severityCounts };
}

export function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return null;
  }
  session.updatedAt = Date.now();
  return session;
}

export function enqueuePluginMessage(sessionId, pluginMessage) {
  const session = ensureSession(sessionId);
  session.pendingPluginMessages.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    pluginMessage,
    createdAt: Date.now(),
  });
  session.updatedAt = Date.now();
  return session.pendingPluginMessages[session.pendingPluginMessages.length - 1];
}

export function drainPluginMessages(sessionId) {
  const session = ensureSession(sessionId);
  const messages = [...session.pendingPluginMessages];
  session.pendingPluginMessages = [];
  session.updatedAt = Date.now();
  return messages;
}
