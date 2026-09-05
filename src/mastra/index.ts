import "dotenv/config";
import { Mastra } from "@mastra/core/mastra";
import { registerApiRoute } from "@mastra/core/server";
import { PinoLogger } from "@mastra/loggers";
import { sharedPgStore } from "./core/db/shared-pg-store.js";

// Workflows & Agents
import { surveyWorkflow } from "./workflows/survey-workflow.js";
import { surveyAgent } from "./agents/survey-agent.js";
import { engagementAgent } from "./agents/engagement-agent.js";

// Tools
import {
  escalateTool,
} from "./tools/escalate-to-human.js";
import {
    sendWhatsAppMessageTool,
} from "./tools/send-whatsapp-message-tool.js";
import {
    sendWhatsAppSurveyTool,
 
} from "./tools/send-whatsapp-survey-tool.js"

import {
   sendWhatsAppTemplateTool,
} from "./tools/send-whatsapp-template-tool.js"
import { sendFeedbackSurveyTool } from "./tools/send-feedback-survey-tool.js";

// Meta Flow APIs
import {
  createMetaFlow,
  uploadFlowJson,
  publishFlow,
} from "./metaFlowApi.js";

// WhatsApp client
import {
  sendWhatsAppMessage,
  markAsRead,
} from "../whatsapp-client.js";
import { knowledgeBaseTool } from "./tools/knowledge-base-tool.js";
import { findNearestBranchTool } from "./tools/get-nearest-distance-tool.js";

/* -------------------------------------------------------------------------- */
/*                                CONFIG                                      */
/* -------------------------------------------------------------------------- */

const pgStorage = sharedPgStore;

/* -------------------------------------------------------------------------- */
/*                                HELPERS                                     */
/* -------------------------------------------------------------------------- */

const getDb = () => (pgStorage as any).db;

/* -------------------------------------------------------------------------- */
/*                              API ROUTES                                    */
/* -------------------------------------------------------------------------- */

const routes = [

  /* -------------------------- SEND SINGLE SURVEY -------------------------- */

  registerApiRoute("admin/send-survey", {
    method: "POST",
    handler: async (c) => {
      const body = await c.req.json().catch(() => null);
      

      if (body?.mode === 'manual' && !body?.surveyId) {
        return c.json({ error: "Woops! You have to provide a surveyId for manual mode" }, 400);
      }

      // Required fields
      if (!body?.to || !body?.topic || !body?.mode) {
        return c.json({ error: "Missing required fields (to, topic, mode)" }, 400);
      }

      const { to, surveyId, topic, mode, context, surveyIntroTemplateId } = body;

      // Only allow valid modes
      if (!['ai', 'manual'].includes(mode)) {
        return c.json({ error: "Invalid mode. Must be one of: ai, manual" }, 400);
      }

      // For manual mode: validate survey exists before starting workflow
      if (mode === 'manual') {
        try {
          const db = getDb();
          if (db) {
            const result = await db.query(
              `SELECT id FROM surveys WHERE id = $1 AND mode = 'manual' AND is_archived = FALSE`,
              [surveyId]
            );
            if (!result?.rows || result.rows.length === 0) {
              return c.json({
                error: 'survey_not_found',
                message: `Manual survey '${surveyId}' does not exist or has been archived. Create it first via POST /admin/survey.`,
              }, 404);
            }
          }
        } catch (dbErr) {
          console.error('Survey existence check failed:', dbErr);
        }
      }

      // For AI mode: do not allow reusing an existing survey ID.
      // This prevents collisions with manual surveys and keeps survey IDs unique.
      if (mode === 'ai' && surveyId) {
        try {
          const db = getDb();
          if (db) {
            const result = await db.query(
              `SELECT id, mode FROM surveys WHERE id = $1 LIMIT 1`,
              [surveyId]
            );
            if (result?.rows && result.rows.length > 0) {
              return c.json({
                error: 'duplicate_survey_id',
                message: `Survey ID '${surveyId}' already exists. Please use a new surveyId for the AI survey.`,
              }, 409);
            }
          }
        } catch (dbErr) {
          console.error('AI survey duplicate ID check failed:', dbErr);
        }
      }


      try {

        // For ai/manual, run the workflow
        const workflow = c.get("mastra").getWorkflow("surveyWorkflow");
        const run = await workflow.createRun();

        // Pass context if present (type-safe)
        const inputData = {
          to,
          surveyId,
          topic,
          ...(context ? { context } : {}),
          ...(surveyIntroTemplateId ? { surveyIntroTemplateId } : {}),
          mode,
        };
        const result = await run.start({ inputData });
        return c.json({ success: true, mode, result });
      } catch (error) {
        return c.json(
          { error: "Survey send failed", details: (error as Error).message },
          500
        );
      }
    },
  }),

  /* -------------------------- BULK SURVEY SEND ---------------------------- */
  registerApiRoute("admin/bulk-send-survey", {
    method: "POST",
    handler: async (c) => {
      const body = await c.req.json().catch(() => null);

      if (!body?.customers || !Array.isArray(body.customers)) {
        return c.json({ error: "Invalid customers array" }, 400);
      }

      const workflow = c.get("mastra").getWorkflow("surveyWorkflow");

      const results = await Promise.all(
        body.customers.map(async (customer: any) => {
          // customer may be a string (phone) or an object { to, mode, context }
          const to = typeof customer === 'string' ? customer : customer?.to;
          const customerMode = (typeof customer === 'object' && customer?.mode) || body.mode;
          const customerContext = (typeof customer === 'object' && customer?.context) || body.context;

          if (!to) {
            return { to: null, success: false, error: 'Invalid input data: \n- to: Invalid input: expected string, received undefined' };
          }

          try {
            // Respect meta mode: send template directly
            const mode = customerMode || body.mode;
            
            // For ai/manual, start a workflow run
            const run = await workflow.createRun();
            const inputData: any = { to, surveyId: body.surveyId, topic: body.topic };
            if (customerContext) inputData.context = customerContext;
            if (mode) inputData.mode = mode;

            const result = await run.start({ inputData });
            return { to, success: true, result };
          } catch (error) {
            return {
              to,
              success: false,
              error: (error as Error).message,
            };
          }
        })
      );

      return c.json({ results });
    },
  }),

  /* -------------------------- GET SURVEY RESPONSES ------------------------ */
  registerApiRoute("admin/survey-responses", {
    method: "GET",
    handler: async (c) => {
      const surveyId        = c.req.query("surveyId");
      const customerNumber  = c.req.query("customerNumber");
      const surveySessionId = c.req.query("surveySessionId");
      const surveyedParam   = c.req.query("surveyed"); // 'true' | 'false'

      try {
        const db = getDb();
        if (!db) throw new Error("DB not available");

        const conditions: string[] = [];
        const values: any[]        = [];

        if (surveyId) {
          values.push(surveyId);
          conditions.push(`r.survey_id = $${values.length}`);
        }
        if (customerNumber) {
          values.push(customerNumber);
          conditions.push(`r.customer_phone = $${values.length}`);
        }
        if (surveySessionId) {
          values.push(surveySessionId);
          conditions.push(`r.session_id = $${values.length}`);
        }

        const filterBySurveyed = surveyedParam === "true" || surveyedParam === "false";

        let sql: string;
        if (filterBySurveyed) {
          // Join sessions so we can filter on completion status
          const statusClause =
            surveyedParam === "true"
              ? `s.status = 'completed'`
              : `s.status != 'completed'`;
          conditions.push(statusClause);
          const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
          sql = `SELECT r.* FROM survey_responses r JOIN survey_sessions s ON s.id = r.session_id ${where} ORDER BY r.created_at DESC`;
        } else {
          const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
          sql = `SELECT r.* FROM survey_responses r ${where} ORDER BY r.created_at DESC`;
        }

        const rows = await db.any(sql, values);
        return c.json({ responses: rows });

      } catch {
        return c.json({ responses: [] });
      }
    },
  })

];



/* -------------------------------------------------------------------------- */
/*                              MASTRA INSTANCE                               */
/* -------------------------------------------------------------------------- */

export const mastra = new Mastra({
  workflows: { surveyWorkflow },
  agents: { surveyAgent, engagementAgent },
  tools: {
    sendWhatsAppMessageTool,
    sendWhatsAppSurveyTool,
    sendWhatsAppTemplateTool,
    sendFeedbackSurveyTool,
    escalateTool,
    knowledgeBaseTool,
    findNearestBranchTool,
    
  },
  storage: pgStorage,
  logger: new PinoLogger({
    name: "FBNBank-WhatsApp-Agent",
    level: "info",
  }),
  server: {
    apiRoutes: routes,
  },
});
