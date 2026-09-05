import { normalizePhone } from '../utils/format_phone.js';

export type ChatRole = 'AI' | 'Human' | 'Customer';

export interface LogChatMessageParams {
  db: any;
  threadId: string;
  role: ChatRole;
  messageText: string;
  escalationId?: string | null;
  sourceMessageId?: string | null;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface ChatHistoryFilters {
  threadId?: string;
  role?: ChatRole;
  escalationId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

const VALID_ROLES: ChatRole[] = ['AI', 'Human', 'Customer'];

async function queryRows(db: any, query: string, params: any[] = []) {
  if (typeof db?.any === 'function') {
    const rows = await db.any(query, params);
    return Array.isArray(rows) ? rows : [];
  }

  if (typeof db?.query === 'function') {
    const result = await db.query(query, params);
    return Array.isArray(result?.rows) ? result.rows : [];
  }

  throw new Error('Invalid db client');
}

function normalizeThreadId(threadId: string) {
  const cleaned = normalizePhone(String(threadId || ''));
  return cleaned || String(threadId || '').trim();
}

function normalizeRole(role: string | undefined): ChatRole | undefined {
  if (!role) return undefined;
  const normalized = role.trim() as ChatRole;
  if (!VALID_ROLES.includes(normalized)) {
    throw new Error('Invalid role');
  }
  return normalized;
}

function normalizeLimit(limit: number | undefined) {
  if (!Number.isFinite(limit as number)) return 50;
  return Math.max(1, Math.min(500, Number(limit)));
}

function normalizeOffset(offset: number | undefined) {
  if (!Number.isFinite(offset as number)) return 0;
  return Math.max(0, Number(offset));
}

function buildHistoryWhere(filters: ChatHistoryFilters, startParam = 1) {
  const clauses: string[] = [];
  const params: any[] = [];

  if (filters.threadId) {
    params.push(normalizeThreadId(filters.threadId));
    clauses.push(`thread_id = $${startParam + params.length - 1}`);
  }

  const role = normalizeRole(filters.role);
  if (role) {
    params.push(role);
    clauses.push(`role = $${startParam + params.length - 1}`);
  }

  if (filters.escalationId) {
    params.push(filters.escalationId);
    clauses.push(`escalation_id = $${startParam + params.length - 1}`);
  }

  if (filters.from) {
    params.push(filters.from);
    clauses.push(`created_at >= $${startParam + params.length - 1}::timestamptz`);
  }

  if (filters.to) {
    params.push(filters.to);
    clauses.push(`created_at <= $${startParam + params.length - 1}::timestamptz`);
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return { whereClause, params };
}

export async function logChatMessage(params: LogChatMessageParams) {
  const content = String(params.messageText || '').trim();
  if (!content) {
    throw new Error('messageText is required');
  }

  const role = normalizeRole(params.role);
  if (!role) {
    throw new Error('Invalid role');
  }

  const threadId = normalizeThreadId(params.threadId);
  if (!threadId) {
    throw new Error('threadId is required');
  }

  const rows = await queryRows(
    params.db,
    `INSERT INTO chat_history (
      thread_id,
      role,
      message_text,
      escalation_id,
      source_message_id,
      channel,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    RETURNING *`,
    [
      threadId,
      role,
      content,
      params.escalationId || null,
      params.sourceMessageId || null,
      params.channel || 'whatsapp',
      JSON.stringify(params.metadata || {}),
    ]
  );

  return rows.length > 0 ? rows[0] : null;
}

export async function getChatHistory(db: any, filters: ChatHistoryFilters) {
  const { whereClause, params } = buildHistoryWhere(filters);
  const limit = normalizeLimit(filters.limit);
  const offset = normalizeOffset(filters.offset);

  const rows = await queryRows(
    db,
    `SELECT id, thread_id, role, message_text, escalation_id, source_message_id, channel, metadata, created_at
     FROM chat_history
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1}
     OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return rows;
}

export async function getChatHistoryThreads(db: any, filters: ChatHistoryFilters) {
  const { whereClause, params } = buildHistoryWhere(filters);
  const limit = normalizeLimit(filters.limit);
  const offset = normalizeOffset(filters.offset);

  const rows = await queryRows(
    db,
    `SELECT
      thread_id,
      COUNT(*)::int AS total_messages,
      COUNT(*) FILTER (WHERE role = 'AI')::int AS ai_messages,
      COUNT(*) FILTER (WHERE role = 'Human')::int AS human_messages,
      COUNT(*) FILTER (WHERE role = 'Customer')::int AS customer_messages,
      MIN(created_at) AS first_message_at,
      MAX(created_at) AS last_message_at,
      (
        ARRAY_REMOVE(ARRAY_AGG(escalation_id ORDER BY created_at DESC), NULL)
      )[1] AS last_escalation_id
     FROM chat_history
     ${whereClause}
     GROUP BY thread_id
     ORDER BY MAX(created_at) DESC
     LIMIT $${params.length + 1}
     OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return rows;
}

export default {
  getChatHistory,
  getChatHistoryThreads,
  logChatMessage,
};
