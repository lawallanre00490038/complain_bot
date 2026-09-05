import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import pool from "../../db/index.js";


const normalizeDigits = (value: string) => value.replace(/\D/g, '');

const pickAccountNumber = (responses: Record<string, any>, preferredFieldKey?: string): string | null => {
  if (!responses || typeof responses !== 'object') return null;

  const direct = preferredFieldKey ? responses?.[preferredFieldKey] : undefined;
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }

  const ignoreKeys = new Set(['flow_id', 'flow_token', 'screen', 'version']);
  for (const [key, value] of Object.entries(responses)) {
    if (ignoreKeys.has(key)) continue;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
};

const findRecentCollectedAccountNumber = async (
  db: { query: (query: string, params: any[]) => Promise<{ rows?: any[] }> },
  customerPhone: string,
): Promise<string | null> => {
  const preferredFieldKey = process.env.ESCALATION_ACCOUNT_NUMBER_FIELD_KEY?.trim();
  const configuredFlowId = process.env.ESCALATION_ACCOUNT_NUMBER_FLOW_ID?.trim();
  const reuseWindowSeconds = Number.parseInt(
    process.env.ESCALATION_ACCOUNT_NUMBER_REUSE_WINDOW_SECONDS || '300',
    10,
  );

  const cutoff = new Date(
    Date.now() - ((Number.isFinite(reuseWindowSeconds) && reuseWindowSeconds > 0 ? reuseWindowSeconds : 300) * 1000),
  ).toISOString();

  const params: any[] = [normalizeDigits(customerPhone), cutoff];
  let sql = `
    SELECT responses
    FROM meta_flow_responses
    WHERE source = 'data_exchange'
      AND regexp_replace(COALESCE(customer_phone, ''), '\\D', '', 'g') = $1
      AND created_at >= $2
  `;

  if (configuredFlowId) {
    sql += ` AND flow_id = $3`;
    params.push(configuredFlowId);
  }

  sql += ` ORDER BY created_at DESC LIMIT 1`;

  const result = await db.query(sql, params);
  const row = Array.isArray(result?.rows) ? result.rows[0] : null;
  if (!row) return null;

  const raw = row.responses;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return pickAccountNumber(parsed ?? {}, preferredFieldKey);
};




const generateTicketId = () => {
  return 'TICKET-' + Math.random().toString(36).substring(2, 11).toUpperCase()
}


const formatDate = (dateVal: any): string => {
  if (!dateVal) return '';
  const d = new Date(dateVal);
  return isNaN(d.getTime()) 
    ? '' 
    : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};


export const escalateTool = createTool({
  id: 'transfer-to-human',
  description: 'Transfer conversation or escalate an issue to a human agent',
  
  inputSchema: z.object({
    message: z.string(),
    category: z.enum(['complaint', 'enquiry', 'request']),
    customerPhone: z.string(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    ticketId: z.string().optional(),
    createdAt: z.string().optional(),
    message: z.string().optional(),
  }),

  execute: async (input, context) => {

    console.log('Escalation tool called with input:', input)

    const ticketId = generateTicketId()
    const createdAt = new Date().toISOString();

    const handoffPhone =
    context?.agent?.threadId?.replace('thread_', '') ||
    input.customerPhone;

    // let resolvedAccountNumber = input.userAccountNumber?.trim() || null;

    // if (!resolvedAccountNumber) {
    //   try {
    //     const client = await pool.connect();
    //     try {
    //       resolvedAccountNumber = await findRecentCollectedAccountNumber(client as any, input.customerPhone);
    //     } finally {
    //       client.release();
    //     }
    //   } catch (error) {
    //     console.error('Failed to auto-resolve account number from recent secure form submission:', error);
    //   }
    // }

    // if (!resolvedAccountNumber) {
    //   console.warn('Escalation blocked: missing user account number after secure form lookup.');
    //   return {
    //     success: false,
    //     message: 'Missing account number. Ask the customer to complete the secure form and confirm before escalating.',
    //   };
    // }

    const params = [
      input.message,
      input.category,
      'pending',
      ticketId,
      input.customerPhone,
      // resolvedAccountNumber,
      handoffPhone,
      createdAt,
    ];

    // Determine DB client: prefer Mastra storage db when available
    const mastraInstance = (context as any)?.mastra ?? (context as any)?.agent?.mastra ?? undefined;
    const storageDb = mastraInstance ? (mastraInstance.getStorage?.() as any)?.db : undefined;

    // STEP 1: Try Mastra Storage DB first
    if (storageDb && typeof storageDb.any === 'function') {
      try {
        await storageDb.any(
          'INSERT INTO escalations (message, category, ticket_status, ticket_id, customer_phone, handoff_phone, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [input.message, input.category, 'pending', ticketId, input.customerPhone, handoffPhone, createdAt]
        )
        console.log('Ticket created successfully (via Mastra storage)')
        return { success: true, ticketId, createdAt: formatDate(new Date()) }
      } catch (error: any) {
        console.error('Error creating ticket (mastra db):', error)
        // If the table doesn't exist (42P01), we can try to fall back or log a specific message
        if (error.code === '42P01') {
           console.error('CRITICAL: The "escalations" table does not exist in the Mastra database. Please create it.');
        }
        // Don't return false yet, try the fallback pool
      }
    }

    // STEP 2: Fallback to local pg pool
    console.log('Attempting to use fallback local pool...');
    let client;
    try {
      client = await pool.connect()
      await client.query(
        'INSERT INTO escalations (message, category, ticket_status, ticket_id, customer_phone, handoff_phone, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [input.message, input.category, 'pending', ticketId, input.customerPhone, handoffPhone, createdAt]
      )
      console.log('Ticket created successfully (via local pool)')
      return { success: true, ticketId, createdAt: formatDate(new Date()) }
    } catch (error: any) {
      console.error('Error creating ticket (pool):', error)
      if (error.code === '42P01') {
           console.error('CRITICAL: The "escalations" table does not exist in the local database. Please create it.');
      }
      return { success: false }
    } finally {
      if (client) {
        try { client.release() } catch (e) { /* ignore */ }
      }
    }
  },
})



// Delete escalation tool if you want to start fresh
export const deleteEscalationTool = createTool({
  id: 'delete-escalation',
  description: 'Delete an escalation ticket by ticket ID',
  inputSchema: z.object({
    ticketId: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string().optional(),
    ticketStatus: z.string().optional(),
  }),
  execute: async (input, context) => {
    const { ticketId } = input
    console.log(`Attempting to delete ticket with ID: ${ticketId}`)

    const mastraInstance = (context as any)?.mastra ?? (context as any)?.agent?.mastra ?? undefined;
    const storageDb = mastraInstance ? (mastraInstance.getStorage?.() as any)?.db : undefined;

    if (storageDb && typeof storageDb.any === 'function') {
      try {
        const existing = await storageDb.any(
          'SELECT ticket_status FROM escalations WHERE ticket_id = $1',
          [ticketId]
        )

        const ticket = Array.isArray(existing) && existing.length > 0 ? existing[0] : null
        if (!ticket) {
          console.warn('No ticket found to delete (via Mastra storage)')
          return { success: false, message: 'Ticket not found.' }
        }

        if (ticket.ticket_status === 'completed') {
          return {
            success: false,
            ticketStatus: ticket.ticket_status,
            message: 'This ticket is already resolved and cannot be deleted.',
          }
        }

        if (ticket.is_archived === true) {
          return {
            success: false,
            ticketStatus: ticket.ticket_status,
            message: 'This ticket is already resolved and cannot be deleted.',
          }
        }

        const result = await storageDb.query(
        `
          UPDATE escalations
          SET
            is_archived = TRUE,
            archived_at = NOW(),
            updated_at = NOW()
          WHERE ticket_id = $1
            AND is_archived = FALSE
          RETURNING ticket_id, ticket_status
        `,
          [ticketId]
        );

        console.log('\n\nMastra DB update result:', result)

        if ((result.rowCount ?? 0) > 0) {
          console.log('Ticket deleted successfully (via Mastra storage)')
          return { success: true, message: 'Ticket deleted successfully.' }
        } else {
          console.warn('No ticket found to delete (via Mastra storage)')
          return { success: false, message: 'Ticket not found.' }
        }
      } catch (error: any) {
        console.error('Error deleting ticket (mastra db):', error)
        if (error.code === '42P01') {
           console.error('CRITICAL: The "escalations" table does not exist in the Mastra database. Please create it.');
        }
        return { success: false, message: 'Failed to delete ticket.' }
      }
    }

    console.log('Attempting to use fallback local pool for deletion...');
    let client;
    try {
      client = await pool.connect()
      const existing = await client.query(
        'SELECT ticket_status FROM escalations WHERE ticket_id = $1',
        [ticketId]
      )
      
      const ticket = (existing.rowCount ?? 0) > 0 ? existing.rows[0] : null
      if (!ticket) {
        console.warn('No ticket found to delete (via local pool)')
        return { success: false, message: 'Ticket not found.' }
      }

      if (ticket.ticket_status === 'completed' || ticket.is_archived === true) {
        return {
          success: false,
          ticketStatus: ticket.ticket_status,
          message: 'This ticket is already resolved or archived and cannot be deleted.',
        }
      }

      const result = await client.query(
        `
          UPDATE escalations
          SET
            is_archived = TRUE,
            archived_at = NOW(),
            updated_at = NOW()
          WHERE ticket_id = $1
            AND is_archived = FALSE
          RETURNING ticket_id, ticket_status
        `,
          [ticketId]
      );

      if ((result.rowCount ?? 0) > 0) {
        console.log('Ticket deleted successfully (via local pool)')
        return { success: true, message: 'Ticket deleted successfully.' }
      } else {
        console.warn('No ticket found to delete (via local pool)')
        return { success: false, message: 'Ticket not found.' }
      }
    } catch (error: any) {
      console.error('Error deleting ticket (pool):', error)
      if (error.code === '42P01') {
           console.error('CRITICAL: The "escalations" table does not exist in the local database. Please create it.');
      }
      return { success: false, message: 'Failed to delete ticket.' }
    } finally {
      if (client) {
        try { client.release() } catch (e) { /* ignore */ }
      }
    }
  },
})



export const getEscalatedTicketsByCustomerPhoneTool = createTool({
  id: 'get-all-escalated-tickets-by-customer-phone',
  description: 'Retrieve all escalation tickets for a customer phone number',

  inputSchema: z.object({
    customerPhone: z.string(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    tickets: z.array(
      z.object({
        ticketId: z.string(),
        message: z.string(),
        category: z.string(),
        ticketStatus: z.string(),
        customerPhone: z.string(),
        createdAt: z.string(),
      })
    ),
  }),

  execute: async (input, context) => {
    const { customerPhone } = input;

    const query = `
      SELECT
        ticket_id,
        message,
        category,
        ticket_status,
        customer_phone,
        created_at
      FROM escalations
      WHERE handoff_phone = $1
        AND COALESCE(is_archived, FALSE) = FALSE
        AND ticket_status != 'completed'
      ORDER BY created_at DESC
    `;



    console.log('\n\ngetEscalatedTicketsByCustomerPhoneTool initialized with input schema:', getEscalatedTicketsByCustomerPhoneTool.inputSchema);
    console.log('Received input for getEscalatedTicketsByCustomerPhoneTool:', input);


    const mastraInstance =
      (context as any)?.mastra ??
      (context as any)?.agent?.mastra ??
      undefined;

    const storageDb = mastraInstance
      ? (mastraInstance.getStorage?.() as any)?.db
      : undefined;

    // ---------- Mastra DB ----------
    if (storageDb && typeof storageDb.any === 'function') {
      try {

         const handoffPhone =
          context?.agent?.threadId?.replace('thread_', '') ||
          input.customerPhone;

        const rows = await storageDb.any(query, [handoffPhone]);

        console.log(`[Mastra DB] Retrieved ${rows.length} tickets for customer phone: ${handoffPhone}`);
        
        return {
          success: true,
          tickets: rows.map((row: any) => ({
            ticketId: row.ticket_id,
            message: row.message,
            category: row.category,
            ticketStatus: row.ticket_status,
            customerPhone: row.customer_phone,
            createdAt: formatDate(row.created_at),
          })),
        };
      } catch (error) {
        console.error(
          'Error retrieving tickets from Mastra DB:',
          error
        );
      }
    }

    // ---------- Fallback Pool ----------
    let client;

    try {
      client = await pool.connect();

      const handoffPhone =
        context?.agent?.threadId?.replace('thread_', '') ||
        input.customerPhone;

      const result = await client.query(query, [handoffPhone]);

      return {
        success: true,
        tickets: result.rows.map((row) => ({
          ticketId: row.ticket_id,
          message: row.message,
          category: row.category,
          ticketStatus: row.ticket_status,
          customerPhone: row.customer_phone,
          createdAt: formatDate(row.created_at),
        })),
      };
    } catch (error) {
      console.error('Error retrieving tickets:', error);

      return {
        success: false,
        tickets: [],
      };
    } finally {
      client?.release();
    }
  },
});



export const getEscalationByTicketIdTool = createTool({
  id: 'get-escalation-by-ticket-id',
  description: 'Retrieve a specific escalation ticket',

  inputSchema: z.object({
    ticketId: z.string(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    escalation: z
      .object({
        ticketId: z.string(),
        message: z.string(),
        category: z.string(),
        ticketStatus: z.string(),
        customerPhone: z.string(),
        createdAt: z.string(),
        updatedAt: z.string().nullable().optional(),
      })
      .nullable(),
  }),

  execute: async (input, context) => {
    const { ticketId } = input;

    const query = `
      SELECT
        ticket_id,
        message,
        category,
        ticket_status,
        customer_phone,
        created_at,
        updated_at
      FROM escalations
      WHERE ticket_id = $1
        AND COALESCE(is_archived, FALSE) = FALSE
        AND ticket_status != 'completed'
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const mastraInstance =
      (context as any)?.mastra ??
      (context as any)?.agent?.mastra ??
      undefined;

    const storageDb = mastraInstance
      ? (mastraInstance.getStorage?.() as any)?.db
      : undefined;

    // ---------- Mastra DB ----------
    if (storageDb && typeof storageDb.any === 'function') {
      try {
        const rows = await storageDb.any(query, [ticketId]);

        const ticket = rows?.[0];

        if (!ticket) {
          return {
            success: false,
            escalation: null,
          };
        }

        return {
          success: true,
          escalation: {
            ticketId: ticket.ticket_id,
            message: ticket.message,
            category: ticket.category,
            ticketStatus: ticket.ticket_status,
            customerPhone: ticket.customer_phone,
            createdAt:
              formatDate(ticket.created_at),
            updatedAt:
              formatDate(ticket.updated_at),
          },
        };
      } catch (error) {
        console.error(
          'Error retrieving escalation from Mastra DB:',
          error
        );
      }
    }

    // ---------- Fallback Pool ----------
    let client;

    try {
      client = await pool.connect();

      const result = await client.query(query, [ticketId]);

      const ticket = result.rows[0];

      if (!ticket) {
        return {
          success: false,
          escalation: null,
        };
      }

      return {
        success: true,
        escalation: {
          ticketId: ticket.ticket_id,
          message: ticket.message,
          category: ticket.category,
          ticketStatus: ticket.ticket_status,
          customerPhone: ticket.customer_phone,
          createdAt:
            formatDate(ticket.created_at),
          updatedAt:
            formatDate(ticket.updated_at),
        },
      };
    } catch (error) {
      console.error(
        'Error retrieving escalation from pool:',
        error
      );

      return {
        success: false,
        escalation: null,
      };
    } finally {
      client?.release();
    }
  },
});



export const updateTicketMessageTool = createTool({
  id: 'update-ticket-message',
  description: 'Update ticket message by ticket ID',
  inputSchema: z.object({
    ticketId: z.string(),
    newMessage: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string().optional(),
  }),
  execute: async (input, context) => {
    const { ticketId, newMessage } = input;
    console.log(`Attempting to update ticket with ID: ${ticketId}`);

    const query = `
      UPDATE escalations
      SET message = $1,
          updated_at = NOW()
      WHERE ticket_id = $2
        AND COALESCE(is_archived, FALSE) = FALSE
        AND ticket_status != 'completed'
      RETURNING ticket_id;
    `;

    const params = [newMessage, ticketId];

    // Determine DB client: prefer Mastra storage db when available
    const mastraInstance = (context as any)?.mastra ?? (context as any)?.agent?.mastra ?? undefined;
    const storageDb = mastraInstance ? (mastraInstance.getStorage?.() as any)?.db : undefined;

    // ---------- STEP 1: Try Mastra Storage DB first ----------
    if (storageDb && typeof storageDb.any === 'function') {
      try {
        const rows = await storageDb.any(query, params);

        if (!rows || rows.length === 0) {
          console.log(`[Mastra DB] No active ticket found with ID: ${ticketId} to update.`);
          return {
            success: false,
            message: 'Ticket not found or cannot be modified.',
          };
        }

        console.log(`Ticket ${ticketId} message updated successfully (via Mastra storage)`);
        return { success: true, message: 'Ticket updated successfully.' };
      } catch (error: any) {
        console.error('Error updating ticket message (mastra db):', error);
        // Fall through to fallback pool if the table or connection issue is isolated
      }
    }

    // ---------- STEP 2: Fallback to local pg pool ----------
    console.log('Attempting to use fallback local pool for update...');
    let client;
    try {
      client = await pool.connect();
      const result = await client.query(query, params);

      if (result.rowCount === 0) {
        console.log(`[Local Pool] No active ticket found with ID: ${ticketId} to update.`);
        return {
          success: false,
          message: 'Ticket not found or cannot be modified.',
        };
      }

      console.log(`Ticket ${ticketId} message updated successfully (via local pool)`);
      return { success: true, message: 'Ticket updated successfully.' };
    } catch (error: any) {
      console.error('Error updating ticket message (pool):', error);
      return { success: false, message: 'Database operation failed.' };
    } finally {
      if (client) {
        try { client.release(); } catch (e) { /* ignore */ }
      }
    }
  },
});
