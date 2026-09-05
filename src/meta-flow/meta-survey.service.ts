/**
 * meta-survey.service.ts
 *
 * Database operations for Meta WhatsApp Flow surveys and their responses.
 *
 * Tables:
 *   meta_flow_surveys   — registered surveys (one row per Meta Flow)
 *   meta_flow_responses — submissions received via the data endpoint webhook
 */

import { randomUUID } from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MetaFlowSurveyRow {
  id: string;
  flow_id: string;
  flow_name: string;
  survey_id: string | null;
  questions_data: any[];
  status: 'draft' | 'published' | 'deprecated';
  data_endpoint_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetaFlowResponseRow {
  id: string;
  flow_id: string;
  flow_token: string;
  customer_phone: string | null;
  survey_id: string | null;
  responses: Record<string, any>;
  source: 'data_exchange' | 'nfm_reply';
  created_at: string;
}

export interface MetaFlowTokenMapRow {
  flow_token: string;
  flow_id: string;
  survey_id: string | null;
  customer_phone: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Survey CRUD ─────────────────────────────────────────────────────────────

/** Insert or update a meta flow survey record */
export async function upsertMetaFlowSurvey(
  db: any,
  params: {
    flowId: string;
    flowName: string;
    surveyId?: string;
    questionsData: any[];
    status?: 'draft' | 'published' | 'deprecated';
    dataEndpointUrl?: string;
  },
): Promise<void> {
  const { flowId, flowName, surveyId, questionsData, status = 'draft', dataEndpointUrl } = params;

  // Try db.none (pg-promise style) first, fall back to db.query (node-postgres)
  const sql = `
    INSERT INTO meta_flow_surveys
      (id, flow_id, flow_name, survey_id, questions_data, status, data_endpoint_url, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
    ON CONFLICT (flow_id) DO UPDATE SET
      flow_name        = EXCLUDED.flow_name,
      survey_id        = EXCLUDED.survey_id,
      questions_data   = EXCLUDED.questions_data,
      status           = EXCLUDED.status,
      data_endpoint_url = EXCLUDED.data_endpoint_url,
      updated_at       = NOW()
  `;


  console.log(
    'Saving questionsData:',
    JSON.stringify(questionsData, null, 2)
  );

  const values = [
    randomUUID(),
    flowId,
    flowName,
    surveyId ?? null,
    JSON.stringify(questionsData),
    status,
    dataEndpointUrl ?? null,
  ];

  if (typeof db.none === 'function') {
    await db.none(sql, values);
  } else {
    await db.query(sql, values);
  }
}

/** Mark a flow's status as published */
export async function markFlowPublished(db: any, flowId: string): Promise<void> {
  const sql = `UPDATE meta_flow_surveys SET status = 'published', updated_at = NOW() WHERE flow_id = $1`;
  if (typeof db.none === 'function') {
    await db.none(sql, [flowId]);
  } else {
    await db.query(sql, [flowId]);
  }
}

/** Mark a flow's status as deprecated */
export async function markFlowDeprecated(db: any, flowId: string): Promise<void> {
  const sql = `UPDATE meta_flow_surveys SET status = 'deprecated', updated_at = NOW() WHERE flow_id = $1`;
  if (typeof db.none === 'function') {
    await db.none(sql, [flowId]);
  } else {
    await db.query(sql, [flowId]);
  }
}

/** Retrieve all registered meta flow surveys */
export async function listMetaFlowSurveys(db: any) {
  const result = await db.query(`
    SELECT *
    FROM meta_flow_surveys
    WHERE is_archived = FALSE
    ORDER BY created_at DESC
  `);

  return result.rows;
}

/** Query meta flow surveys with optional filters */
export async function queryMetaFlowSurveys(
  db: any,
  params: {
    archived?: boolean;
    number?: string;
    flowId?: string;
    surveyId?: string;
    limit?: number;
    offset?: number;
    from?: string;
    to?: string;
  },
): Promise<MetaFlowSurveyRow[]> {
  const conditions: string[] = [];
  const values: any[] = [];

  const archived = params.archived ?? false;
  values.push(archived);
  conditions.push(`is_archived = $${values.length}`);

  if (params.flowId) {
    values.push(params.flowId);
    conditions.push(`flow_id = $${values.length}`);
  }

  if (params.surveyId) {
    values.push(params.surveyId);
    conditions.push(`survey_id = $${values.length}`);
  }

  if (params.number) {
    values.push(`%${params.number}%`);
    conditions.push(`(flow_id ILIKE $${values.length} OR survey_id ILIKE $${values.length})`);
  }

  if (params.from) {
    values.push(params.from);
    conditions.push(`created_at >= $${values.length}`);
  }

  if (params.to) {
    values.push(params.to);
    conditions.push(`created_at <= $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(params.limit ?? 50, 500);
  const offset = params.offset ?? 0;

  values.push(limit, offset);
  const sql = `
    SELECT *
    FROM meta_flow_surveys
    ${where}
    ORDER BY created_at DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}
  `;

  if (typeof db.any === 'function') return db.any(sql, values);
  const result = await db.query(sql, values);
  return result.rows;
}

/** Count surveys with optional filters */
export async function countMetaFlowSurveys(
  db: any,
  params: {
    archived?: boolean;
    number?: string;
    flowId?: string;
    surveyId?: string;
    from?: string;
    to?: string;
  },
): Promise<number> {
  const conditions: string[] = [];
  const values: any[] = [];

  const archived = params.archived ?? false;
  values.push(archived);
  conditions.push(`is_archived = $${values.length}`);

  if (params.flowId) {
    values.push(params.flowId);
    conditions.push(`flow_id = $${values.length}`);
  }

  if (params.surveyId) {
    values.push(params.surveyId);
    conditions.push(`survey_id = $${values.length}`);
  }

  if (params.number) {
    values.push(`%${params.number}%`);
    conditions.push(`(flow_id ILIKE $${values.length} OR survey_id ILIKE $${values.length})`);
  }

  if (params.from) {
    values.push(params.from);
    conditions.push(`created_at >= $${values.length}`);
  }

  if (params.to) {
    values.push(params.to);
    conditions.push(`created_at <= $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT COUNT(*) AS total FROM meta_flow_surveys ${where}`;

  if (typeof db.one === 'function') {
    const row = await db.one(sql, values);
    return Number(row.total);
  }

  const result = await db.query(sql, values);
  return Number(result.rows[0]?.total ?? 0);
}


/** Retrieve a single meta flow survey by its Meta flow_id */
export async function getMetaFlowSurveyByFlowId(
  db: any,
  flowId: string,
): Promise<MetaFlowSurveyRow | null> {
  const sql = `SELECT * FROM meta_flow_surveys WHERE flow_id = $1 LIMIT 1`;
  if (typeof db.oneOrNone === 'function') return db.oneOrNone(sql, [flowId]);
  const result = await db.query(sql, [flowId]);

  console.log(
    'FLOW LOOKUP:',
    flowId,
    JSON.stringify(result.rows[0], null, 2)
  );

  return result.rows[0] ?? null;
}

/** Delete a survey record from local DB (does not call Meta API) */
export async function deleteMetaFlowSurveyRecord(db: any, flowId: string): Promise<void> {
  const sql = `DELETE FROM meta_flow_surveys WHERE flow_id = $1`;
  if (typeof db.none === 'function') {
    await db.none(sql, [flowId]);
  } else {
    await db.query(sql, [flowId]);
  }
}


export async function archiveMetaFlowSurvey(db: any, flowId: string) {
  const result = await db.query(
    `
    UPDATE meta_flow_surveys
    SET
      is_archived = TRUE,
      archived_at = NOW(),
      updated_at = NOW()
    WHERE flow_id = $1
      AND is_archived = FALSE
    RETURNING flow_id
    `,
    [flowId]
  );

  return result.rows[0] ?? null;
}

/** Upsert mapping between a flow token and its flow id for later nfm_reply correlation */
export async function upsertMetaFlowTokenMap(
  db: any,
  params: {
    flowToken: string;
    flowId: string;
    surveyId?: string;
    customerPhone?: string;
  },
): Promise<void> {
  const { flowToken, flowId, surveyId, customerPhone } = params;

  const sql = `
    INSERT INTO meta_flow_token_map
      (flow_token, flow_id, survey_id, customer_phone, created_at, updated_at)
    VALUES ($1, $2, $3, $4, NOW(), NOW())
    ON CONFLICT (flow_token) DO UPDATE SET
      flow_id        = EXCLUDED.flow_id,
      survey_id      = COALESCE(EXCLUDED.survey_id, meta_flow_token_map.survey_id),
      customer_phone = COALESCE(EXCLUDED.customer_phone, meta_flow_token_map.customer_phone),
      updated_at     = NOW()
  `;

  const values = [
    flowToken,
    flowId,
    surveyId ?? null,
    customerPhone ?? null,
  ];

  if (typeof db.none === 'function') {
    await db.none(sql, values);
    await db.none(
      `
        UPDATE meta_flow_responses
        SET
          flow_id = $2,
          survey_id = COALESCE(meta_flow_responses.survey_id, $3)
        WHERE flow_token = $1
          AND flow_id = 'unknown'
      `,
      [flowToken, flowId, surveyId ?? null],
    );
  } else {
    await db.query(sql, values);
    await db.query(
      `
        UPDATE meta_flow_responses
        SET
          flow_id = $2,
          survey_id = COALESCE(meta_flow_responses.survey_id, $3)
        WHERE flow_token = $1
          AND flow_id = 'unknown'
      `,
      [flowToken, flowId, surveyId ?? null],
    );
  }
}

/** Resolve flow id/survey id by flow token */
export async function getMetaFlowTokenMapByToken(
  db: any,
  flowToken: string,
): Promise<MetaFlowTokenMapRow | null> {
  const sql = `SELECT * FROM meta_flow_token_map WHERE flow_token = $1 LIMIT 1`;
  if (typeof db.oneOrNone === 'function') return db.oneOrNone(sql, [flowToken]);
  const result = await db.query(sql, [flowToken]);
  return result.rows[0] ?? null;
}

/** Check whether a flow token already exists in token map or responses */
export async function isMetaFlowTokenUsed(db: any, flowToken: string): Promise<boolean> {
  const sql = `
    SELECT 1 AS hit FROM meta_flow_token_map WHERE flow_token = $1
    UNION ALL
    SELECT 1 AS hit FROM meta_flow_responses WHERE flow_token = $1
    LIMIT 1
  `;

  if (typeof db.oneOrNone === 'function') {
    const row = await db.oneOrNone(sql, [flowToken]);
    return !!row;
  }

  const result = await db.query(sql, [flowToken]);
  return (result.rows?.length ?? 0) > 0;
}



/** Delete all responses for a flow from local DB */
export async function deleteMetaFlowResponsesByFlowId(db: any, flowId: string): Promise<void> {
  const sql = `DELETE FROM meta_flow_responses WHERE flow_id = $1`;
  if (typeof db.none === 'function') {
    await db.none(sql, [flowId]);
  } else {
    await db.query(sql, [flowId]);
  }
}

// ─── Response CRUD ────────────────────────────────────────────────────────────

export async function saveMetaFlowResponse(
  db: any,
  params: {
    flowId: string;
    flowToken: string;
    customerPhone?: string;
    surveyId?: string;
    responses: Record<string, any>;
    source?: 'data_exchange' | 'nfm_reply';
  },
): Promise<void> {
  const {
    flowId,
    flowToken,
    customerPhone,
    surveyId,
    responses,
    source = 'data_exchange',
  } = params;

  const sql = `
    INSERT INTO meta_flow_responses
      (id, flow_id, flow_token, customer_phone, survey_id, responses, source, created_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, NOW())
  `;

  const values = [
    randomUUID(),
    flowId,
    flowToken,
    customerPhone ?? null,
    surveyId ?? null,
    JSON.stringify(responses),
    source,
  ];

  if (typeof db.none === 'function') {
    await db.none(sql, values);
  } else {
    await db.query(sql, values);
  }
}


/** Query meta flow responses with optional filters */
export async function queryMetaFlowResponses(
  db: any,
  params: {
    flowId?: string;
    customerPhone?: string;
    surveyId?: string;
    source?: string;
    from?: string; // ISO date string
    to?: string;   // ISO date string
    limit?: number;
    offset?: number;
  },
): Promise<MetaFlowResponseRow[]> {
  const conditions: string[] = [];
  const values: any[] = [];

  const add = (col: string, val: any) => {
    values.push(val);
    conditions.push(`${col} = $${values.length}`);
  };

  if (params.flowId) add('flow_id', params.flowId);
  if (params.customerPhone) add('customer_phone', params.customerPhone);
  if (params.surveyId) add('survey_id', params.surveyId);
  if (params.source) add('source', params.source);

  if (params.from) {
    values.push(params.from);
    conditions.push(`created_at >= $${values.length}`);
  }
  if (params.to) {
    values.push(params.to);
    conditions.push(`created_at <= $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(params.limit ?? 50, 500);
  const offset = params.offset ?? 0;

  values.push(limit, offset);
  const sql = `
    SELECT * FROM meta_flow_responses
    ${where}
    ORDER BY created_at DESC
    LIMIT $${values.length - 1} OFFSET $${values.length}
  `;

  if (typeof db.any === 'function') return db.any(sql, values);
  const result = await db.query(sql, values);
  return result.rows;
}

/** Count total responses (for pagination) */
export async function countMetaFlowResponses(
  db: any,
  params: { flowId?: string; customerPhone?: string; surveyId?: string; source?: string; from?: string; to?: string },
): Promise<number> {
  const conditions: string[] = [];
  const values: any[] = [];

  const add = (col: string, val: any) => {
    values.push(val);
    conditions.push(`${col} = $${values.length}`);
  };

  if (params.flowId) add('flow_id', params.flowId);
  if (params.customerPhone) add('customer_phone', params.customerPhone);
  if (params.surveyId) add('survey_id', params.surveyId);
  if (params.source) add('source', params.source);

  if (params.from) {
    values.push(params.from);
    conditions.push(`created_at >= $${values.length}`);
  }
  if (params.to) {
    values.push(params.to);
    conditions.push(`created_at <= $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT COUNT(*) AS total FROM meta_flow_responses ${where}`;

  if (typeof db.one === 'function') {
    const row = await db.one(sql, values);
    return Number(row.total);
  }
  const result = await db.query(sql, values);
  return Number(result.rows[0]?.total ?? 0);
}

export function mapResponsesToQuestions(responses: Record<string, any>, questionsData: any[]) {
  return Object.entries(responses).map(([key, value]) => {
    const question = questionsData.find(q => q.id === key || q.name === key);
    return {
      field_id: key,
      question_text: question ? (question.text || question.label || question.title) : key,
      answer: value
    };
  });
}

// ─── Accumulated Responses (multi-screen partial saves) ───────────────────────

/**
 * Returns the merged answers accumulated so far for a given flow_token.
 * Used by the data_exchange handler to make conditional navigation decisions.
 */
export async function getAccumulatedFlowResponses(
  db: any,
  flowToken: string,
): Promise<Record<string, any>> {
  const sql = `SELECT answers FROM meta_flow_accumulated WHERE flow_token = $1 LIMIT 1`;
  let row: any;
  if (typeof db.oneOrNone === 'function') {
    row = await db.oneOrNone(sql, [flowToken]);
  } else {
    const result = await db.query(sql, [flowToken]);
    row = result.rows[0] ?? null;
  }
  if (!row) return {};
  try {
    return typeof row.answers === 'string' ? JSON.parse(row.answers) : row.answers ?? {};
  } catch {
    return {};
  }
}

/**
 * Upserts the accumulated answers for a flow_token (one row per session).
 * Called on every data_exchange screen submission to merge partial answers.
 */
export async function upsertAccumulatedFlowResponses(
  db: any,
  params: {
    flowToken: string;
    flowId: string;
    surveyId?: string;
    customerPhone?: string;
    answers: Record<string, any>;
  },
): Promise<void> {
  const { flowToken, flowId, surveyId, customerPhone, answers } = params;
  const sql = `
    INSERT INTO meta_flow_accumulated
      (flow_token, flow_id, survey_id, customer_phone, answers, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
    ON CONFLICT (flow_token) DO UPDATE SET
      answers      = $5,
      updated_at   = NOW()
  `;
  const values = [
    flowToken,
    flowId,
    surveyId ?? null,
    customerPhone ?? null,
    JSON.stringify(answers),
  ];
  if (typeof db.none === 'function') {
    await db.none(sql, values);
  } else {
    await db.query(sql, values);
  }
}
