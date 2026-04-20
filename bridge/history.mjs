import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HISTORY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'history');

function ensureHistoryDir() {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

/**
 * Append one audit run record to bridge/history/{fileId}.jsonl.
 * Each line is a self-contained JSON object so the file is easy to stream/parse.
 *
 * @param {string} fileId   - Figma file key (or sessionId as fallback)
 * @param {object} entry    - { sessionId, score, severityCounts, auditCount, audits, meta }
 */
export function appendAuditHistory(fileId, entry) {
  ensureHistoryDir();
  const safeKey = String(fileId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(HISTORY_DIR, `${safeKey}.jsonl`);
  const record = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  fs.appendFileSync(filePath, record + '\n', 'utf8');
}

/**
 * Read all audit history records for a given fileId.
 * Returns an array of parsed record objects, oldest first.
 */
export function readAuditHistory(fileId) {
  ensureHistoryDir();
  const safeKey = String(fileId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = path.join(HISTORY_DIR, `${safeKey}.jsonl`);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter(Boolean);
}
