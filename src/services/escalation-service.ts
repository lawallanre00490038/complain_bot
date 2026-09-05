import { sendWhatsAppMessage as sendWA } from '../whatsapp-client.js';
import { normalizePhone } from '../utils/format_phone.js';

const VALID_TICKET_STATUSES = ['pending', 'completed'] as const;
const VALID_MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
const COLUMN_EXISTS_CACHE = new Map<string, boolean>();

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

async function columnExists(db: any, tableName: string, columnName: string) {
  const cacheKey = `${tableName}.${columnName}`;
  if (COLUMN_EXISTS_CACHE.has(cacheKey)) {
    return COLUMN_EXISTS_CACHE.get(cacheKey) as boolean;
  }

  const rows = await queryRows(
    db,
    `SELECT 1
     FROM information_schema.columns
     WHERE table_name = $1 AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );

  const exists = rows.length > 0;
  COLUMN_EXISTS_CACHE.set(cacheKey, exists);
  return exists;
}

export async function getEscalationByTicketId(db: any, ticketId: string) {
  const rows = await queryRows(db, 'SELECT * FROM escalations WHERE ticket_id = $1', [ticketId]);
  return rows.length > 0 ? rows[0] : null;
}

export async function getLatestActiveEscalationByPhone(db: any, customerPhone: string) {
  const normalizedPhone = normalizePhone(customerPhone);
  const hasHandoffPhone = await columnExists(db, 'escalations', 'handoff_phone');
  const rows = hasHandoffPhone
    ? await queryRows(
      db,
      `SELECT * FROM escalations
       WHERE regexp_replace(COALESCE(handoff_phone, customer_phone, ''), '\\D', '', 'g') = $1
       AND ticket_status = $2
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedPhone, 'pending']
    )
    : await queryRows(
      db,
      `SELECT * FROM escalations
       WHERE regexp_replace(COALESCE(customer_phone, ''), '\\D', '', 'g') = $1
       AND ticket_status = $2
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedPhone, 'pending']
    );
  return rows.length > 0 ? rows[0] : null;
}

export async function getLatestHumanOwnedEscalationByPhone(db: any, customerPhone: string) {
  const normalizedPhone = normalizePhone(customerPhone);
  const hasHandoffPhone = await columnExists(db, 'escalations', 'handoff_phone');
  const rows = hasHandoffPhone
    ? await queryRows(
      db,
      `SELECT * FROM escalations
       WHERE regexp_replace(COALESCE(handoff_phone, customer_phone, ''), '\\D', '', 'g') = $1
       AND ticket_status = $2
       AND human_agent_active = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedPhone, 'pending']
    )
    : await queryRows(
      db,
      `SELECT * FROM escalations
       WHERE regexp_replace(COALESCE(customer_phone, ''), '\\D', '', 'g') = $1
       AND ticket_status = $2
       AND human_agent_active = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedPhone, 'pending']
    );
  return rows.length > 0 ? rows[0] : null;
}

export async function getEscalations(db: any, status?: string) {
  if (status) {
    return await queryRows(db, 'SELECT * FROM escalations WHERE ticket_status = $1 ORDER BY created_at DESC', [status]);
  }
  return await queryRows(db, 'SELECT * FROM escalations ORDER BY created_at DESC');
}

export async function updateTicketStatus(db: any, ticketId: string, ticketStatus: string) {
  if (!VALID_TICKET_STATUSES.includes(ticketStatus as (typeof VALID_TICKET_STATUSES)[number])) {
    throw new Error('Invalid ticketStatus');
  }

  const res = await queryRows(
    db,
    `UPDATE escalations
     SET ticket_status = $1,
         human_agent_active = CASE WHEN $1 = 'completed' THEN FALSE ELSE human_agent_active END,
         updated_at = NOW()
     WHERE ticket_id = $2
     RETURNING *`,
    [ticketStatus, ticketId]
  );
  return Array.isArray(res) && res.length > 0 ? res[0] : null;
}

export async function setHumanAgentActive(db: any, ticketId: string, active: boolean) {
  const res = await queryRows(
    db,
    `UPDATE escalations
     SET human_agent_active = $1,
         human_engaged_at = CASE WHEN $1 THEN NOW() ELSE human_engaged_at END,
         updated_at = NOW()
     WHERE ticket_id = $2
     RETURNING *`,
    [active, ticketId]
  );
  return Array.isArray(res) && res.length > 0 ? res[0] : null;
}

export async function setEscalationHandoffPhone(db: any, ticketId: string, handoffPhone: string) {
  const normalized = normalizePhone(handoffPhone);
  if (await columnExists(db, 'escalations', 'handoff_phone')) {
    const res = await queryRows(
      db,
      `UPDATE escalations
       SET handoff_phone = $1,
           updated_at = NOW()
       WHERE ticket_id = $2
       RETURNING *`,
      [normalized, ticketId]
    );
    return Array.isArray(res) && res.length > 0 ? res[0] : null;
  }

  const res = await queryRows(
    db,
    `UPDATE escalations
     SET customer_phone = $1,
         updated_at = NOW()
     WHERE ticket_id = $2
     RETURNING *`,
    [normalized, ticketId]
  );
  return Array.isArray(res) && res.length > 0 ? res[0] : null;
}

export interface NotifyParams {
  db: any;
  ticketId?: string;
  ticketStatus?: string;
  to?: string;
  message?: string;
  sendMessage?: (to: string, message: string) => Promise<boolean>;
}

export interface HumanAgentMessageParams {
  db: any;
  ticketId: string;
  message: string;
  to?: string;
  sendMessage?: (to: string, message: string) => Promise<boolean>;
}

export interface EscalationMessageLogParams {
  db: any;
  ticketId: string;
  direction: 'inbound' | 'outbound';
  messageText: string;
  customerPhone?: string;
  sourceMessageId?: string;
}

export async function notifyAndMaybeUpdate(params: NotifyParams) {
  const { db, ticketId, ticketStatus } = params;
  let { to, message } = params;
  
  const sendMessage: (to: string, message: string) => Promise<boolean> = params.sendMessage ?? (async (to: string, message: string) => {
    return await sendWA({ to, message });
  });

  if (ticketId && ticketStatus) {
    const updated = await updateTicketStatus(db, ticketId, ticketStatus);
    if (!updated) throw new Error('not_found');
    if (!to && updated && updated.customer_phone) to = updated.customer_phone;
  }

  if (!to) {
    if (ticketId) {
      const ticket = await getEscalationByTicketId(db, ticketId);
      if (ticket && ticket.customer_phone) to = ticket.customer_phone;
    }
  }

  if (!to) {
    throw new Error('customer_phone (to) is required');
  }

  if (!message) {
    message = ticketId || ticketStatus ? `Update: ticket ${ticketId || ''} status ${ticketStatus || ''}`.trim() : 'Notification from support team.';
  }

  const sent = await sendMessage(to, message);
  return { sent, to, message };
}

export async function sendHumanAgentMessage(params: HumanAgentMessageParams) {
  const { db, ticketId } = params;
  const message = params.message?.trim();

  if (!message) {
    throw new Error('message is required');
  }

  const ticket = await getEscalationByTicketId(db, ticketId);
  if (!ticket) {
    throw new Error('not_found');
  }

  if (ticket.ticket_status !== 'pending') {
    throw new Error('ticket_not_active');
  }

  if (!ticket.human_agent_active) {
    const claimed = await setHumanAgentActive(db, ticketId, true);
    if (!claimed) {
      throw new Error('not_found');
    }
  }

  const to = params.to || ticket.customer_phone;
  if (!to) {
    throw new Error('customer_phone (to) is required');
  }

  await setEscalationHandoffPhone(db, ticketId, to);

  const sendMessage: (to: string, message: string) => Promise<boolean> = params.sendMessage ?? (async (destination: string, outgoing: string) => {
    return await sendWA({ to: destination, message: outgoing });
  });

  const sent = await sendMessage(to, message);
  await logEscalationMessage({
    db,
    ticketId,
    direction: 'outbound',
    messageText: message,
    customerPhone: to,
  });

  return {
    sent,
    to,
    message,
    ticketId: ticket.ticket_id,
    ticketStatus: ticket.ticket_status,
  };
}

export async function logEscalationMessage(params: EscalationMessageLogParams) {
  const { db, ticketId, messageText, customerPhone, sourceMessageId } = params;
  const direction = params.direction;

  if (!VALID_MESSAGE_DIRECTIONS.includes(direction)) {
    throw new Error('Invalid direction');
  }

  const content = (messageText || '').trim();
  if (!content) {
    throw new Error('messageText is required');
  }

  const rows = await queryRows(
    db,
    `INSERT INTO escalation_messages (ticket_id, direction, message_text, customer_phone, source_message_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [ticketId, direction, content, customerPhone ? normalizePhone(customerPhone) : null, sourceMessageId || null]
  );

  return rows.length > 0 ? rows[0] : null;
}

export async function getEscalationMessages(db: any, ticketId: string, direction?: 'inbound' | 'outbound', limit = 50) {
  const safeLimit = Math.max(1, Math.min(200, Number.isFinite(limit) ? limit : 50));
  if (direction && !VALID_MESSAGE_DIRECTIONS.includes(direction)) {
    throw new Error('Invalid direction');
  }

  const rows = direction
    ? await queryRows(
      db,
      `SELECT * FROM escalation_messages
       WHERE ticket_id = $1 AND direction = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [ticketId, direction, safeLimit]
    )
    : await queryRows(
      db,
      `SELECT * FROM escalation_messages
       WHERE ticket_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [ticketId, safeLimit]
    );

  return rows;
}

export default {
  getEscalationByTicketId,
  getLatestActiveEscalationByPhone,
  getLatestHumanOwnedEscalationByPhone,
  getEscalationMessages,
  getEscalations,
  logEscalationMessage,
  sendHumanAgentMessage,
  setEscalationHandoffPhone,
  setHumanAgentActive,
  updateTicketStatus,
  notifyAndMaybeUpdate,
};
