import { randomUUID } from 'crypto';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import pool from '../../db/index.js';
import { sendFlowMessage } from '../metaFlowApi.js';
import * as metaSurveyService from '../../meta-flow/meta-survey.service.js';
import { normalizePhone } from '../../utils/format_phone.js';

type QueryableDb = {
  any?: (query: string, params?: any[]) => Promise<any[]>;
  query?: (query: string, params?: any[]) => Promise<{ rows?: any[] }>;
};

function pickAccountNumber(responses: Record<string, any>, preferredFieldKey?: string): string | null {
  if (!responses || typeof responses !== 'object') return null;

  const direct = preferredFieldKey
    ? responses?.[preferredFieldKey]
    : undefined;

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
}

async function queryRows(db: QueryableDb, query: string, params: any[] = []) {
  if (typeof db?.any === 'function') {
    const rows = await db.any(query, params);
    return Array.isArray(rows) ? rows : [];
  }

  if (typeof db?.query === 'function') {
    const result = await db.query(query, params);
    return Array.isArray(result?.rows) ? result.rows : [];
  }

  return [];
}

export const collectAccountNumberViaMetaFlowTool = createTool({
  id: 'collect-account-number-via-meta-flow',
  description:
    'Collect the customer account number securely using a WhatsApp Meta Flow. If a recent response already exists for the customer, it returns it.',
  inputSchema: z.object({
    customerPhone: z.string().describe('Customer phone number (used for escalation and Meta Flow send target).'),
    responseFieldKey: z.string().optional().describe('Optional key of the account-number field inside the flow response payload.'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    status: z.enum(['pending', 'collected', 'failed']),
    flowToken: z.string().optional(),
    accountNumber: z.string().optional(),
    message: z.string().optional(),
  }),
  execute: async (input, context) => {
    const handoffPhone =
      context?.agent?.threadId?.replace('thread_', '') ||
      input.customerPhone;

    const normalizedPhone = normalizePhone(String(handoffPhone));

    const flowId = process.env.ESCALATION_ACCOUNT_NUMBER_FLOW_ID?.trim();
    const configuredFlowMode =
      process.env.ESCALATION_ACCOUNT_NUMBER_FLOW_MODE?.trim().toLowerCase() === 'published'
        ? 'published'
        : 'draft';

    if (!flowId) {
      return {
        success: false,
        status: 'failed' as const,
        message: 'Missing ESCALATION_ACCOUNT_NUMBER_FLOW_ID configuration.',
      };
    }

    const preferredFieldKey =
      input.responseFieldKey?.trim() ||
      process.env.ESCALATION_ACCOUNT_NUMBER_FIELD_KEY?.trim();
    const reuseWindowSeconds = Number.parseInt(
      process.env.ESCALATION_ACCOUNT_NUMBER_REUSE_WINDOW_SECONDS || '300',
      10,
    );
    const reuseWindowMs = Number.isFinite(reuseWindowSeconds) && reuseWindowSeconds > 0
      ? reuseWindowSeconds * 1000
      : 300000;

    const mastraInstance = (context as any)?.mastra ?? (context as any)?.agent?.mastra;
    const storageDb = mastraInstance?.getStorage?.()?.db as QueryableDb | undefined;

    const runLookup = async (db: QueryableDb) => {
      const rows = await queryRows(
        db,
        `
          SELECT responses, created_at
          FROM meta_flow_responses
          WHERE flow_id = $1
            AND source = 'data_exchange'
            AND regexp_replace(COALESCE(customer_phone, ''), '\\D', '', 'g') = $2
          ORDER BY created_at DESC
          LIMIT 1
        `,
        [flowId, normalizedPhone],
      );

      const latestRow = rows?.[0];
      if (!latestRow) return null;

      const createdAt = latestRow?.created_at ? new Date(latestRow.created_at).getTime() : NaN;
      const isRecent = Number.isFinite(createdAt) && (Date.now() - createdAt) <= reuseWindowMs;
      if (!isRecent) {
        return null;
      }

      const latest = latestRow.responses;
      const parsed = typeof latest === 'string' ? JSON.parse(latest) : latest;
      return pickAccountNumber(parsed ?? {}, preferredFieldKey);
    };

    try {
      if (storageDb) {
        const existing = await runLookup(storageDb);
        if (existing) {
          return {
            success: true,
            status: 'collected' as const,
            accountNumber: existing,
            message: 'Account number was found from a previously submitted secure flow.',
          };
        }
      }

      const client = await pool.connect();
      try {
        const existing = await runLookup(client as unknown as QueryableDb);
        if (existing) {
          return {
            success: true,
            status: 'collected' as const,
            accountNumber: existing,
            message: 'Account number was found from a previously submitted secure flow.',
          };
        }
      } finally {
        client.release();
      }

      const flowToken = `escalation-account-${Date.now()}-${randomUUID().slice(0, 8)}`;

      await sendFlowMessage({
        to: normalizedPhone,
        flowId,
        flowToken,
        flowMode: configuredFlowMode,
        cta: 'Secure Form',
        headerText: 'FBNBank Secure Capture',
        bodyText: 'Please submit your account number in this secure form to continue escalation.',
        footerText: 'Do not send account numbers in chat.',
      });

      if (storageDb) {
        await metaSurveyService.upsertMetaFlowTokenMap(storageDb, {
          flowToken,
          flowId,
          surveyId: 'escalation-account-number',
          customerPhone: normalizedPhone,
        });
      } else {
        const client = await pool.connect();
        try {
          await metaSurveyService.upsertMetaFlowTokenMap(client as any, {
            flowToken,
            flowId,
            surveyId: 'escalation-account-number',
            customerPhone: normalizedPhone,
          });
        } finally {
          client.release();
        }
      }

      return {
        success: true,
        status: 'pending' as const,
        flowToken,
        message:
          'Secure account-number form sent. Ask the customer to complete it and then confirm in chat so you can call this tool again.',
      };
    } catch (error: any) {
      console.error('collect-account-number-via-meta-flow failed', error);
      return {
        success: false,
        status: 'failed' as const,
        message: error?.message || 'Failed to collect account number via Meta Flow.',
      };
    }
  },
});
