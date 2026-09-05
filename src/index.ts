

import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import cors from "cors";
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import crypto from "crypto";
import swaggerUi from 'swagger-ui-express';
import express, { Application, NextFunction, Request, Response } from 'express';
import { createServer } from 'http';
import { MastraServer } from '@mastra/express';
import { mastra } from './mastra/index.js';

import { normalizePhone } from './utils/format_phone.js';
import { sendWhatsAppMessage, sendWhatsAppSurvey, sendWhatsAppReadReceipt, sendWhatsAppMessageOrTemplate } from './whatsapp-client.js';
import { lastOutboundType, setLastOutbound } from './utils/outboundTracker.js';
import escalationService from './services/escalation-service.js';
import chatHistoryService from './services/chat-history-service.js';
import { initDatabase } from './db-init.js';
// WhatsApp Webhook: Handle incoming messages
import { routeIncomingMessage } from './webhook/router.js';

// Meta WhatsApp Flow Surveys
import { buildSurveyFlowJson, computeVisibilityData, sanitizeOptionId } from './meta-flow/flow-builder.js';
import * as metaSurveyService from './meta-flow/meta-survey.service.js';
import {
  createMetaFlow,
  uploadFlowJsonBuffer,
  publishFlow,
  deprecateFlow,
  deleteFlow,
  getFlow,
  sendFlowMessage,
} from './mastra/metaFlowApi.js';

// RAG / Knowledge Base
import kbUploadRoute from './mastra/core/rag/routes/upload.route.js';
import kbDocsRoute from './mastra/core/rag/routes/docs.route.js';
import { createKbDocsTable } from './mastra/core/rag/db.js';
import { initVectorIndex } from './mastra/core/rag/vector-store.js';
import { warmUpEmbeddingModel } from "./mastra/core/llm/provider.js";
import { buildAdminListQuery } from "./utils/build-filter.js";
import { setupRealtimeHub, broadcastEscalationMessage } from './utils/realtime.js';

dotenv.config();

const seenInboundMessageIds = new Map<string, number>();
const SEEN_INBOUND_TTL_MS = 10 * 60 * 1000;

function isDuplicateInboundMessage(messageId: string): boolean {
  const now = Date.now();

  for (const [id, timestamp] of seenInboundMessageIds) {
    if (now - timestamp > SEEN_INBOUND_TTL_MS) {
      seenInboundMessageIds.delete(id);
    }
  }

  if (seenInboundMessageIds.has(messageId)) {
    return true;
  }

  seenInboundMessageIds.set(messageId, now);
  return false;
}

function getSingleRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}


const app: Application = express();
app.locals.mastra = mastra as any;
app.disable('x-powered-by');

const trustProxyRaw = process.env.TRUST_PROXY;
if (trustProxyRaw === undefined || trustProxyRaw === '') {
  app.set('trust proxy', 1);
} else if (trustProxyRaw === 'true') {
  app.set('trust proxy', true);
} else if (trustProxyRaw === 'false') {
  app.set('trust proxy', false);
} else {
  const trustProxyHops = Number(trustProxyRaw);
  app.set('trust proxy', Number.isNaN(trustProxyHops) ? 1 : trustProxyHops);
}

void warmUpEmbeddingModel().catch(console.error);




const args = process.argv;

const portIndex = args.indexOf("--port");

const PORT =
  portIndex !== -1 && args[portIndex + 1]
    ? Number(args[portIndex + 1])
    : Number(process.env.PORT || 3000);


const URL =
  process.env.REMOTE_URL?.replace(/\/$/, '')

const enableSwagger = ['1', 'true', 'yes', 'on'].includes(
  (process.env.ENABLE_SWAGGER || 'true').toLowerCase()
);

const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  : true;

// Security headers and fingerprinting protection.
app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  contentSecurityPolicy: false,
}));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Webhook rate limit exceeded.' },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Upload rate limit exceeded, please try again shortly.' },
});

const adminApiKeyMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return res.status(503).json({ success: false, error: 'Admin API key not configured on the server.' });
  }

  const provided = req.headers['x-api-key'];
  const providedKey = Array.isArray(provided) ? provided[0] : provided;
  if (!providedKey || providedKey !== adminKey) {
    return res.status(401).json({ success: false, error: 'Missing or invalid X-Api-Key header.' });
  }

  next();
};

app.use(globalLimiter);
app.use('/webhook', webhookLimiter);
app.use('/api/kb/upload', uploadLimiter);
app.use('/admin', adminApiKeyMiddleware);
app.use('/api/kb', adminApiKeyMiddleware);

app.use(express.json({ 
  limit: '2mb',
  verify: (req: any, _res, buf) => {
    req.rawBody = buf; // Save the raw buffer for signature verification
  }
}));

app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));

// // Enforce HTTPS on supported clients to reduce MITM downgrade risk.
// app.use((_req, res, next) => {
//   res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
//   next();
// });


// Knowledge Base routes
app.use('/api/kb/upload', kbUploadRoute);
app.use('/api/kb/docs', kbDocsRoute);

app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});


// Agent chat test route
app.post('/api/agent/chat', async (req: Request, res: Response) => {
  try {
    const { phone, message, contactName } = req.body as { phone?: string; message?: string; contactName?: string };
    if (!message?.trim()) {
      return res.status(400).json({ success: false, error: '"message" is required' });
    }
    const threadPhone = phone?.trim() || 'test-user';
    const agent = mastra.getAgent('engagementAgent');
    const messages: any[] = [];
    const normalizedPhone = normalizePhone(threadPhone);

    messages.push({
      role: 'system',
      content: `Customer WhatsApp phone: ${normalizedPhone}. This is the customer's current WhatsApp number. You DO have access to this number. If the customer says "use the one you have", "use this number", or similar during escalation, treat this WhatsApp number as the provided contact number and only ask them to confirm whether it is the number linked to their FBNBank account. Do not say you do not have access to their phone number.`,
    });

    if (contactName) {
      messages.push({ role: 'system', content: `Customer name: ${contactName}. Address the customer by this name when appropriate.` });
    }

    messages.push({ role: 'user', content: message });
    const response = await agent.generate(messages, {
      memory: { thread: `thread_${threadPhone}`, resource: threadPhone },
    });

    // setLastOutbound(threadPhone, 'engagementAgent');

    return res.json({ success: true, reply: response?.text?.trim() ?? '' });
  } catch (err: any) {
    console.error('❌ /api/agent/chat error:', err);
    return res.status(500).json({ success: false, error: err?.message ?? 'Internal error' });
  }
});

app.post('/api/agent/reset', async (req: Request, res: Response) => {
  try {
    // 1. Grab Mastra's primary storage subsystem
    const storage = mastra.getStorage();
    if (!storage) {
      return res.status(404).json({ 
        success: false, 
        error: 'Mastra storage provider is not configured or initialized.' 
      });
    }

    // 2. Access the dedicated 'memory' store domain (manages threads, messages, and observations)
    const memoryStore = await storage.getStore('memory');
    if (!memoryStore) {
      return res.status(404).json({ 
        success: false, 
        error: 'Memory store domain could not be retrieved.' 
      });
    }

    // 3. Fetch all threads across all resources/agents (omitting the filter loads everything)
    const result = await memoryStore.listThreads({
      page: 0,
      perPage: false, // Disables pagination limits to fetch every record
    });

    const threads = result?.threads || [];

    // 4. Clean slate: Delete every thread sequentially
    const deletedThreads: string[] = [];

    for (const thread of threads) {

      console.log(`[INFO] Deleting thread ID: ${thread.id}`);
      deletedThreads.push(thread.id);

      await memoryStore.deleteThread({ threadId: thread.id });
    }

    // 5. Log for auditing purposes
    console.log(`[AUDIT] Global agent memory reset initiated. Cleared ${threads.length} conversation threads at ${new Date().toISOString()}`);

    return res.json({
      success: true,
      message: `Successfully reset agent states. Cleared all ${threads.length} conversation threads across all agents.`,
      deletedThreads,
    });
  } catch (err: any) {
    console.error('❌ /api/agent/reset error:', err);
    return res.status(500).json({ 
      success: false, 
      error: err?.message ?? 'Internal server error during memory cleanup' 
    });
  }
});


console.log('Database connection configuration loaded.');

// Serve Swagger UI at /docs
const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Senegal Survey and Whatsapp AI Agent API',
    version: '1.0.0',
    description: 'API docs for webhook and admin survey endpoints',
  },
  servers: [
    {
      url: URL,
      description: "The URL for viewing and testing the API locally or remotely depending on environment configuration",
    },
  ],
  tags: [
    { name: 'Webhook', description: 'WhatsApp webhook verification and inbound events' },
    { name: 'Admin - AI/Manual Survey', description: 'CRM-triggered survey and campaign endpoints modules' },
    { name: 'Admin - Meta Survey', description: 'Create and manage WhatsApp Flow surveys powered by the Meta Flows API. Submissions are saved directly to your database.' },
    { name: 'Admin - Escalation', description: 'Human handoff and escalation operations' },
    { name: 'Admin - Chat History', description: 'Thread and message history retrieval endpoints' },
    { name: 'Knowledge Base', description: 'Knowledge base document ingest and management' },
    { name: 'Agent', description: 'Agent testing endpoint' },
    { name: 'Health', description: 'Liveness endpoint' },
  ],
  components: {
    schemas: {

      MetaFlowSurveyDefinition: {
        type: 'object',
        required: ['name', 'questions'],
        properties: {
          name: { type: 'string', example: 'Post-Transaction Survey', description: 'Survey name (first 30 chars used as screen title).' },
          description: { type: 'string', description: 'Intro text on the opening screen.', example: 'Help us improve your banking experience.' },
          surveyId: { type: 'string', description: 'Internal survey ID saved in DB.', example: 'csat-q1-2026' },
          thankYouText: { type: 'string', description: 'Message on the terminal COMPLETE screen.', example: 'Thank you! Your feedback helps us serve you better.' },
          questions: { type: 'array', items: { $ref: '#/components/schemas/MetaFlowQuestion' }, minItems: 1 },
          autoPublish: { type: 'boolean', default: false, description: 'If true, publishes immediately after upload. **Irreversible** — published flows cannot be unpublished.' },
          dataEndpointUrl: { type: 'string', example: 'https://your-server.ngrok.io/webhook/meta-flow-data', description: 'HTTPS URL of your data endpoint. Defaults to `SERVER_URL + /webhook/meta-flow-data`.' }
        }
    },

    MetaFlowQuestion: {
      type: 'object',
      required: ['id', 'text', 'type'],
      properties: {
        id: { type: 'string', description: 'Unique identifier used as the form field name.' },
        text: { type: 'string', description: 'The question text shown to the user.' },
        type: { type: 'string', enum: ['list', 'button', 'multi', 'text', 'textarea', 'date'], description: 'The UI component type.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Array of strings for list, button, or multi types.' },
        required: { type: 'boolean', default: true, description: 'Whether the field is mandatory.' },
        placeholder: { type: 'string', description: 'Helper text shown inside the component.' },
        sectionTitle: { type: 'string', description: 'Optional section label for RadioButtonsGroup.' },
        allowMultiple: { type: 'boolean', description: 'When true, the question supports multi-select.' },
        showIf: { $ref: '#/components/schemas/FlowCondition', description: 'Optional condition to control visibility dynamically.' }
      }
    },

    FlowCondition: {
      type: 'object',
      required: ['dependsOn', 'equals'],
      properties: {
        dependsOn: { type: 'string', description: 'The ID of the parent question to watch.' },
        equals: { type: 'string', description: 'The specific answer value that triggers this question to become visible.' }
      }
    },

      SurveyQuestion: {
        type: 'object',
        required: ['id', 'text', 'type'],
        properties: {
          id: { type: 'string', example: 'satisfaction', description: 'Unique field identifier (no spaces). Used to reference this question in `showIf.dependsOn`.' },
          text: { type: 'string', example: 'How satisfied are you with our service?', description: 'The question text shown to the customer.' },
          type: { type: 'string', enum: ['button', 'list', 'text', 'multi'], description: '`button` = interactive reply buttons (max 3); `list` = scrollable list (max 10); `multi` = multi-select list/buttons; `text` = free-text reply.' },
          options: { type: 'array', items: { type: 'string' }, example: ['Very Satisfied', 'Satisfied', 'Neutral', 'Dissatisfied', 'Very Dissatisfied'], description: 'Required for `button` and `list` types.' },
          sectionTitle: { type: 'string', example: 'Rating', description: 'Optional header shown above a button group.' },
          placeholder: { type: 'string', example: 'Please share your experience...', description: 'Placeholder/hint text for free-text questions.' },
          showIf: {
            $ref: '#/components/schemas/FlowCondition',
            description: 'When set, this question is only sent if the referenced parent question received the specified answer. Skipped silently otherwise.'
          }
        }
      },
      SurveyTemplate: {
        type: 'object',
        required: ['id', 'name', 'questions'],
        properties: {
          id: { type: 'string', example: 'csat-q2-2026', description: 'Unique survey identifier. Used when triggering this survey via `/admin/send-survey`.' },
          name: { type: 'string', example: 'Post-Transaction Satisfaction Survey', description: 'Human-readable survey name stored in the DB.' },
          mode: { type: 'string', enum: ['manual', 'ai', 'meta'], default: 'manual', description: '`manual` = predefined questions; `ai` = AI-generated; `meta` = WhatsApp Flow.' },
          questions: { type: 'array', items: { $ref: '#/components/schemas/SurveyQuestion' }, description: 'Ordered list of questions. Conditional questions (with `showIf`) are automatically skipped if their condition is not met.' }
        }
      }
    },
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Api-Key',
        description: 'Admin API key required for all /admin endpoints.',
      },
    },
  },

  paths: {
  '/webhook/whatsapp': {
    post: {
      summary: 'Receive WhatsApp webhook events',
      tags: ['Webhook'],
      description: `
      Handles incoming events from the WhatsApp Business API, including:
      - User messages (text, button clicks)
      - Delivery and read status updates

      This endpoint acts as the entry point for all real-time customer interactions. 
      Incoming messages are parsed and routed to the appropriate AI agent (engagement or survey flow).

      Important:
      - Must respond with HTTP 200 quickly to avoid retries from Meta
      - Payload structure follows WhatsApp Cloud API format
      `,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object' }
          }
        }
      },
      responses: {
        '200': { description: 'Event received and processed successfully' },
        '500': { description: 'Webhook processing failed' }
      }
    }
  },

  '/admin/send-survey': {
    post: {
      summary: 'Send a survey to a single customer',
      tags: ['Admin - AI/Manual Survey'],
      description: `
      Triggers a Mastra workflow to send a survey via WhatsApp.

      **Supported modes** (required — choose one):

      | Mode | Description |
      |------|-------------|
      | \`ai\` | AI-generated questions dynamically created at runtime based on the topic and context |
      | \`manual\` | Uses predefined survey templates stored in the system |

      The workflow manages:
      - Question sequencing
      - User responses
      - Session tracking

      This endpoint is typically called by CRM systems.
      `,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                to: { type: 'string', description: 'Customer phone number (E.164 format)' },
                surveyId: { type: 'string' },
                topic: { type: 'string' },
                mode: {
                  type: 'string',
                  enum: ['ai', 'manual'],
                  description: '**ai** — AI-generated questions | **manual** — predefined template | **meta** — approved WhatsApp template'
                },
                context: { type: 'string', description: 'Optional AI context for personalization' },
                surveyIntroTemplateId: {
                  type: 'string',
                  description: 'Optional approved WhatsApp template id to use for the survey intro message. If not provided or send fails, system falls back to interactive intro.'
                }
              },
              required: ['to', 'topic', 'mode']
            },
            examples: {
              ai_mode: {
                summary: 'AI mode — dynamic question generation',
                value: { to: '2348123456789', surveyId: 'sat-001', topic: 'Customer Satisfaction', mode: 'ai', context: 'Premium tier customer', surveyIntroTemplateId: 'survey_intro_v1' }
              },
              manual_mode: {
                summary: 'Manual mode — predefined template',
                value: { to: '2348123456789', surveyId: 'nps-template-001', topic: 'NPS Survey', mode: 'manual', surveyIntroTemplateId: 'survey_intro_v1' }
              }
            }
          }
        }
      },
      responses: {
        '200': { description: 'Survey workflow successfully started' },
        '400': { description: 'Invalid request payload' },
        '500': { description: 'Failed to start workflow' }
      }
    }
  },

  '/admin/bulk-send-survey': {
    post: {
    summary: 'Send surveys to multiple customers',
    tags: ['Admin - AI/Manual Survey'],
    description: `
    Triggers survey workflows for multiple customers in a single request.

    Each phone number in the \`customers\` array represents a unique recipient. 
    A separate workflow execution is started per recipient, enabling parallel processing 
    and consistent delivery at scale.

    **Supported modes** (required — choose one):

    | Mode | Description |
    |------|-------------|
    | \`ai\` | AI-generated questions dynamically created at runtime based on the topic and context |
    | \`manual\` | Uses predefined survey templates stored in the system |

    Top-level fields (\`surveyId\`, \`topic\`, \`mode\`, \`context\`) are applied globally 
    to all recipients.

    Typical use cases:
    - Customer satisfaction campaigns
    - Product feedback collection
    - Large-scale outreach and engagement

    Note:
    - Phone numbers must be in E.164 format (without '+')
    - Personalization is applied uniformly unless extended in future versions
    `,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              surveyId: { 
                type: 'string',
                description: 'Unique identifier for the survey'
              },
              topic: { 
                type: 'string',
                description: 'Survey topic used for AI generation or categorization'
              },
              mode: { 
                type: 'string', 
                enum: ['ai', 'manual'],
                description: '**ai** — AI-generated questions | **manual** — predefined template | **meta** — approved WhatsApp template'
              },
              context: { 
                type: 'string',
                description: 'Optional context to guide AI or campaign messaging'
              },
              customers: {
                type: 'array',
                description: 'List of recipient phone numbers (E.164 format without +, e.g., 2348123456789)',
                items: {
                  type: 'string',
                  example: '2348123456789'
                }
              }
            },
            required: ['customers', 'mode']
          },
          examples: {
            bulk_ai_mode: {
              summary: 'Bulk — AI mode',
              value: {
                surveyId: 'customer-sat-001',
                topic: 'Customer Satisfaction',
                mode: 'ai',
                context: 'Premium users campaign',
                customers: ['2348123456789', '2348012345678']
              }
            },
            bulk_manual_mode: {
              summary: 'Bulk — Manual mode',
              value: {
                surveyId: 'nps-template-001',
                topic: 'NPS Survey',
                mode: 'manual',
                customers: ['2348123456789', '2348012345678']
              }
            },
          }
        }
      }
    },
    responses: {
      '200': { description: 'Bulk survey workflows triggered successfully' },
      '400': { description: 'Invalid request payload or missing required fields' },
      '500': { description: 'Failed to process bulk survey request' }
    }
  }
  },





  // ─── Admin - Meta Survey ──────────────────────────────────────────────────

  '/admin/meta-survey': {
    post: {
      summary: 'Create a Meta WhatsApp Flow survey',
      tags: ['Admin - Meta Survey'],
      description: `Creates a survey as a Meta WhatsApp Flow:

  1. Generates valid Flow JSON from your questions
  2. Creates the flow on the Meta Flows API
  3. Uploads the Flow JSON
  4. Optionally publishes it (\`autoPublish: true\`)
  5. Saves the registration to your local DB

  When a customer submits the form in WhatsApp, responses are POSTed to your \`/webhook/meta-flow-data\` endpoint and saved to \`meta_flow_responses\`.

  ---
  ### Question types

  | type | WhatsApp component | Best for | Max options |
  |------|-------------------|----------|-------------|
  | \`list\` | Dropdown | 3–10 choices | 200 |
  | \`button\` | RadioButtonsGroup | 2–5 choices | 5 |
  | \`text\` | TextInput | Short free text | — |
  | \`textarea\` | TextArea | Long free text | — |
  | \`date\` | DatePicker | Date selection | — |

  ### Conditional Visibility
  You can dynamically show or hide questions on the client side using the \`showIf\` property. This evaluates the user's selection in real-time. If a hidden field is marked as required, Meta automatically bypasses the validation.

  ### Flow screen layout
  \`\`\`
  INTRO (navigate) → QUESTIONS (data_exchange) → COMPLETE (terminal)
  \`\`\`

  > **Publishing note:** Once published, a flow **cannot be unpublished** — only deprecated. Use \`autoPublish: false\` (default) to review in the Meta Flow Builder first.`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/MetaFlowSurveyDefinition' },
              examples: {
                csat: {
                  summary: 'Meta survey with mixed question types and conditional visibility',
                  value: {
                    name: 'Post-Transaction Survey',
                    description: 'Help us improve your banking experience. Takes 1 minute.',
                    surveyId: 'csat-q1-2026',
                    thankYouText: 'Thank you! Your feedback helps us serve you better.',
                    autoPublish: false,
                    "questions": [
                      { 
                        "id": "service_channels", 
                        "text": "Which of our services do you use? (Select all that apply)", 
                        "type": "multi", 
                        "options": [
                          "Mobile Banking",
                          "Internet Banking",
                          "ATM Services",
                          "Branch Banking"
                        ], 
                        "allowMultiple": true,
                        "required": true 
                      },
                      { 
                        "id": "overall_rating", 
                        "text": "How would you rate our overall service?", 
                        "type": "list", 
                        "options": [
                          "Very Satisfied",
                          "Satisfied",
                          "Neutral",
                          "Dissatisfied",
                          "Very Dissatisfied"
                        ], 
                        "required": true 
                      },
                      { 
                        "id": "additional_comment", 
                        "text": "Any other comments or feedback for us?", 
                        "type": "text", 
                        "required": false, 
                        "placeholder": "Type your feedback here..."
                      },
                      { 
                        "id": "improvement_areas", 
                        "text": "Which areas should we improve? (Select all that apply)", 
                        "type": "multi", 
                        "options": [
                          "Speed",
                          "Customer Support",
                          "Security",
                          "User Experience"
                        ], 
                        "allowMultiple": true,
                        "required": false,
                        "showIf": { 
                          "dependsOn": "overall_rating", 
                          "equals": "Dissatisfied" 
                        }
                      },
                      { 
                        "id": "recommendation", 
                        "text": "Would you recommend FBNBank to a friend or colleague?", 
                        "type": "button", 
                        "options": [
                          "Yes",
                          "No",
                          "Maybe"
                        ], 
                        "required": true,
                        "showIf": { 
                          "dependsOn": "overall_rating", 
                          "equals": "Very Dissatisfied" 
                        }
                      }
                    ]
                  }
                },
                nps: {
                  summary: 'NPS Survey',
                  value: {
                    name: 'Net Promoter Score',
                    surveyId: 'nps-2026',
                    autoPublish: false,
                    questions: [
                      { id: 'nps_score', text: 'How likely are you to recommend us? (1–10)', type: 'list', options: ['1','2','3','4','5','6','7','8','9','10'], required: true },
                      { id: 'nps_reason', text: 'Main reason for your score?', type: 'textarea', required: false }
                    ]
                  }
                }
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Flow created (and optionally published)',
            content: { 'application/json': { schema: { type: 'object', properties: {
              success: { type: 'boolean' },
              flowId: { type: 'string' },
              surveyId: { type: 'string', nullable: true },
              status: { type: 'string', enum: ['draft','published'] },
              dataEndpointUrl: { type: 'string' },
              uploadResult: { type: 'object' },
              publishResult: { type: 'object', nullable: true }
            }}}}
          },
          '400': { description: 'Validation error' },
          '500': { description: 'Meta API or server error' }
        }
      },
      get: {
        summary: 'List Meta Flow surveys (filterable)',
        tags: ['Admin - Meta Survey'],
        description: 'Returns Meta WhatsApp Flow surveys with optional filters. By default, only unarchived surveys are returned.',
        parameters: [
          { name: 'archived', in: 'query', required: false, schema: { type: 'boolean', default: false }, description: 'When true, returns archived surveys; default false (unarchived only).' },
          { name: 'number', in: 'query', required: false, schema: { type: 'string' }, description: 'Fuzzy match against flow_id or survey_id.' },
          { name: 'flowId', in: 'query', required: false, schema: { type: 'string' }, description: 'Exact Meta Flow ID filter.' },
          { name: 'surveyId', in: 'query', required: false, schema: { type: 'string' }, description: 'Exact internal survey ID filter.' },
          { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Created-at start date (ISO 8601).' },
          { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Created-at end date (ISO 8601).' },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50, maximum: 500 } },
          { name: 'offset', in: 'query', required: false, schema: { type: 'integer', default: 0 } }
        ],
        responses: {
          '200': { description: 'Filtered survey records with pagination metadata' },
          '400': { description: 'Invalid query parameters' }
        }
      }
    },



  '/admin/meta-survey/{flowId}': {
    get: {
      summary: 'Get a specific Meta Flow survey',
      tags: ['Admin - Meta Survey'],
      description: 'Returns the local DB record plus live status from the Meta Flows API (includes validation errors and preview URL).',
      parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Survey details' }, '404': { description: 'Not found' } }
    },
    delete: {
      summary: 'Delete a DRAFT Meta Flow survey',
      tags: ['Admin - Meta Survey'],
      description: 'Hard-deletes the flow from Meta and removes the local DB survey record. Only works on **DRAFT** flows that were never published. For published flows use `/delete-published`.',
      parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Deleted' },
        '400': { description: 'Flow is published — use /delete-published' },
        '404': { description: 'Not found' }
      }
    }
  },

  '/admin/meta-survey/{flowId}/publish': {
    post: {
      summary: 'Publish a Meta Flow survey',
      tags: ['Admin - Meta Survey'],
      description: '⚠ **Irreversible.** Makes the flow live. Verify in the Meta Flow Builder before publishing. To stop sending, use `/deprecate`.',
      parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Published' }, '404': { description: 'Not found' } }
    }
  },

  '/admin/meta-survey/{flowId}/deprecate': {
    post: {
      summary: 'Deprecate a published Meta Flow',
      tags: ['Admin - Meta Survey'],
      description: 'Soft-disables a published flow. The flow can no longer be sent to customers. Existing response data is preserved.',
      parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Deprecated' }, '404': { description: 'Not found' } }
    }
  },

  '/admin/meta-survey/{flowId}/delete-published/archived': {
    delete: {
      summary: 'Delete a PUBLISHED Meta Flow survey',
      tags: ['Admin - Meta Survey'],
      description: 'For published/deprecated flows: deprecates on Meta (if needed) and removes the local survey record. Responses are preserved. Use `/delete-with-responses` to remove responses too.',
      parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Published flow removed from local registry' },
        '400': { description: 'Flow is not published/deprecated' },
        '404': { description: 'Not found' }
      }
    }
  },

  '/admin/meta-survey/{flowId}/delete-with-responses/purge': {
    delete: {
      summary: 'Dangerous! Delete a flow and all its saved responses',
      tags: ['Admin - Meta Survey'],
      description: 'Deletes the flow handling state and all local response records for the given flow. For DRAFT flows, it hard-deletes on Meta. For published/deprecated flows, it deprecates (if needed) then removes local records.',
      parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Flow and responses deleted from local DB' },
        '404': { description: 'Not found' }
      }
    }
  },

  '/admin/meta-survey/send': {
    post: {
      summary: 'Send a Meta Flow survey to one or many customers',
      tags: ['Admin - Meta Survey'],
      description: `Sends an interactive WhatsApp Flow message with a CTA button that opens the survey inside WhatsApp.

      You can send to a **single customer** or a **list of customers** in one request.

      The **\`flowToken\`** can be any non-empty string (for example \`first-survey\`).
      - If omitted, the server auto-generates one.
      - If sending to multiple recipients, the server appends \`-1\`, \`-2\`, ... to keep each token unique for DB correlation.
      - If provided manually, it must be unique for each send context.`,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['to','flowId'],
                  properties: {
                    to: {
                      oneOf: [
                        { type: 'string', example: '234901234567' },
                        { type: 'array', items: { type: 'string' }, example: ['234901234567', '2348012345678'], minItems: 1 }
                      ],
                      description: 'Recipient phone or list of recipient phones in E.164 without +.'
                    },
                    flowId: { type: 'string', example: '1234567890', description: 'Meta Flow ID returned by POST /admin/meta-survey' },
                    flowToken: { type: 'string', example: 'first-survey', description: 'Optional base token. Must be unique. For bulk sends, server auto-suffixes per recipient for uniqueness.' },
                    cta: { type: 'string', default: 'Take Survey', description: 'CTA button label (max 20 chars)' },
                    headerText: { type: 'string', description: 'Message header (max 60 chars)' },
                    bodyText: { type: 'string', description: 'Message body shown before the CTA button (max 1024 chars)' },
                    footerText: { type: 'string', description: 'Message footer (max 60 chars)' },
                    phoneNumberId: { type: 'string', description: 'Override WhatsApp Phone Number ID (defaults to env var)' }
                  }
                },
                examples: {
                  single: {
                    summary: 'Single recipient',
                    value: {
                      to: '234901234567',
                      flowId: '1234567890',
                      flowToken: 'first-survey',
                      cta: 'Take Survey',
                      bodyText: 'Please help us improve by completing a 1-minute survey.',
                      headerText: 'Quick Survey'
                    }
                  },
                  bulk: {
                    summary: 'Bulk recipients',
                    value: {
                      to: ['2349013360717', '2348012345678'],
                      flowId: '1234567890',
                      flowToken: 'june-csat',
                      cta: 'Take Survey',
                      bodyText: 'Please complete this 1-minute survey.'
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Message(s) sent (all or partial success)' },
            '400': { description: 'Validation error' },
            '409': { description: 'flowToken already exists' },
            '500': { description: 'Send failed for all recipients' }
          }
        }
      },

  '/webhook/meta-flow-data': {
    post: {
      summary: 'Meta Flow Data Endpoint (submissions receiver)',
      tags: ['Webhook'],
      description: `**WhatsApp Flows Data Endpoint** — Meta calls this URL during flow execution.

      Set this as the \`dataEndpointUrl\` when creating surveys (or set \`SERVER_URL\` env var).

      ### Actions

      | action | trigger | server response |
      |--------|---------|-----------------|
      | \`INIT\` | User opens QUESTIONS screen | \`{ screen: "QUESTIONS", data: {} }\` |
      | \`data_exchange\` | User taps **Submit Responses** | Saves to DB → \`{ screen: "COMPLETE", data: {} }\` |
      | \`BACK\` | User navigates back (if refresh_on_back=true) | \`{ screen: current, data: {} }\` |

      ### Response saved on \`data_exchange\`
      Form fields are saved immediately to \`meta_flow_responses\` with:
      - \`flow_id\` — the Meta Flow ID
      - \`flow_token\` — unique token from the send (correlates to your send record)
      - \`responses\` — map of question IDs → submitted values
      - \`source: "data_exchange"\`

      > **Production note:** Meta encrypts the payload. Add decryption using \`FLOW_PRIVATE_KEY\` before going live.`,
        requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                version: { type: 'string', example: '3.0' },
                action: { type: 'string', enum: ['INIT','data_exchange','BACK'] },
                screen: { type: 'string', example: 'QUESTIONS' },
                data: { type: 'object', description: 'For data_exchange: map of form field names to values', example: { satisfaction: 'Very Satisfied', recommend: 'Yes', improvement: 'Faster app' } },
                flow_token: { type: 'string', example: 'a3f7c1d2-0000-4abc-b789-0000deadbeef' },
                flow_id: { type: 'string', example: '1234567890' }
              }
            }
          }
        }
      },
      responses: {
        '200': { description: 'Returns next screen instruction for the Flow client' },
        '500': { description: 'Server error' }
      }
    }
  },


  '/admin/meta-survey/responses': {
    get: {
      summary: 'Query Meta Flow survey responses',
      tags: ['Admin - Meta Survey'],
      description: 'Returns survey responses saved from Meta WhatsApp Flow submissions (both `data_exchange` and `nfm_reply` sources).',
      parameters: [
        { name: 'flowId', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by Meta Flow ID' },
        { name: 'customerPhone', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by customer phone (E.164 without +)' },
        { name: 'surveyId', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by internal survey ID' },
        { name: 'source', in: 'query', required: false, schema: { type: 'string', enum: ['data_exchange','nfm_reply'] }, description: 'Filter by submission source' },
        { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Start date (ISO 8601)' },
        { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'End date (ISO 8601)' },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50, maximum: 500 } },
        { name: 'offset', in: 'query', required: false, schema: { type: 'integer', default: 0 } }
      ],
      responses: {
        '200': {
          description: 'Array of response records',
          content: { 'application/json': { schema: { type: 'object', properties: {
            count: { type: 'integer' },
            total: { type: 'integer', description: 'Total matching records' },
            responses: { type: 'array', items: { type: 'object', properties: {
              id: { type: 'string' },
              flow_id: { type: 'string' },
              flow_token: { type: 'string' },
              customer_phone: { type: 'string', nullable: true },
              survey_id: { type: 'string', nullable: true },
              responses: { type: 'object', description: 'Map of question IDs to submitted values', example: { satisfaction: 'Very Satisfied', recommend: 'Yes' } },
              source: { type: 'string', enum: ['data_exchange','nfm_reply'] },
              created_at: { type: 'string', format: 'date-time' }
            }}}
          }}}}
        }
      }
    }
  },

  '/admin/survey-responses': {
    get: {
      summary: 'Retrieve survey responses',
      tags: ['Admin - AI/Manual Survey'],
      description: `
      Fetches stored survey responses from the database.

      Supports optional filtering by:
      - **surveyId**: Filter responses belonging to a specific survey
      - **customerNumber**: Filter responses for a specific customer (phone number)
      - **surveySessionId**: Filter responses from a specific survey session
      - **surveyed**: \`true\` returns only responses where the session is completed; \`false\` returns responses from active or abandoned sessions

      Used for:
      - Analytics dashboards
      - Reporting
      - Data export
      `,
      parameters: [
        {
          name: 'surveyId',
          in: 'query',
          required: false,
          description: 'Filter by survey ID',
          schema: { type: 'string' }
        },
        {
          name: 'customerNumber',
          in: 'query',
          required: false,
          description: 'Filter by customer phone number (E.164 format without +, e.g. 2348123456789)',
          schema: { type: 'string', example: '2348123456789' }
        },
        {
          name: 'surveySessionId',
          in: 'query',
          required: false,
          description: 'Filter by a specific survey session ID',
          schema: { type: 'string' }
        },
        {
          name: 'surveyed',
          in: 'query',
          required: false,
          description: '`true` — only responses from completed sessions; `false` — responses from active or abandoned sessions',
          schema: { type: 'string', enum: ['true', 'false'] }
        }
      ],
      responses: {
        '200': { description: 'Survey responses retrieved successfully' }
      }
    }
  },

  '/admin/survey': {
    post: {
      summary: 'Create a manual survey',
      tags: ['Admin - AI/Manual Survey'],
      description: `Creates a reusable survey definition stored in the \`surveys\` table.

These surveys power the **manual** mode — when triggering a survey via \`/admin/send-survey\`, the system sends questions one-by-one over WhatsApp chat using the template defined here.

### Question types
| type | WhatsApp component | Best for |
|------|--------------------|----------|
| \`button\` | Interactive reply buttons | 2–3 choices |
| \`list\` | Interactive list picker | 4–10 choices |
| \`text\` | Plain text reply | Free-form answers |

### Conditional visibility (\`showIf\`)
A question with \`showIf\` is only sent if the customer's previous answer matches. Otherwise it is silently skipped and the next applicable question is sent immediately.

\`\`\`json
{ "dependsOn": "satisfaction", "equals": "Very Dissatisfied" }
\`\`\`

Use cases:
- Regulatory-compliant fixed questionnaires
- NPS / onboarding / CSAT flows
- Conditional follow-up questions based on prior answers`,

      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SurveyTemplate' },
            examples: {
              csat_with_conditional: {
                summary: 'Survey with mixed single-select, multi-select, text, and conditional follow-up',
                value: {
                  id: 'csat-q2-2026',
                  name: 'Post-Transaction Satisfaction Survey',
                  mode: 'manual',
                  questions: [
                    {
                      id: 'service_channels',
                      text: 'Which of our services do you use? (Select all that apply)',
                      type: 'multi',
                      options: ['Mobile Banking', 'Internet Banking', 'ATM Services', 'Branch Banking'],
                      allowMultiple: true,
                    },
                    {
                      id: 'overall_rating',
                      text: 'How would you rate our overall service?',
                      type: 'list',
                      options: ['Very Satisfied', 'Satisfied', 'Neutral', 'Dissatisfied', 'Very Dissatisfied'],
                    },
                    {
                      id: 'additional_comment',
                      text: 'Any other comments or feedback for us?',
                      type: 'text',
                      placeholder: 'Type your feedback here...',
                    },
                    {
                      id: 'improvement_areas',
                      text: 'Which areas should we improve? (Select all that apply)',
                      type: 'multi',
                      options: ['Speed', 'Customer Support', 'Security', 'User Experience'],
                      allowMultiple: true,
                      showIf: { dependsOn: 'overall_rating', equals: 'Dissatisfied' },
                    },
                    {
                      id: 'recommendation',
                      text: 'Would you recommend FBNBank to a friend or colleague?',
                      type: 'button',
                      options: ['Yes', 'No', 'Maybe'],
                      showIf: { dependsOn: 'overall_rating', equals: 'Very Dissatisfied' },
                    },
                  ],
                },
              },
              nps: {
                summary: 'Simple NPS Survey (no conditionals)',
                value: {
                  id: 'nps-2026',
                  name: 'Net Promoter Score',
                  mode: 'manual',
                  questions: [
                    {
                      id: 'nps_score',
                      text: 'On a scale of 1–10, how likely are you to recommend FBNBank to a friend?',
                      type: 'list',
                      options: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'],
                    },
                    {
                      id: 'nps_reason',
                      text: 'What is the main reason for your score?',
                      type: 'text',
                      placeholder: 'Tell us more...',
                    },
                  ],
                },
              },
            },
          },
        },
      },

      responses: {
        '201': {
          description: 'Survey created successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  survey: {
                    type: 'object',
                    properties: {
                      id: { type: 'string', example: 'csat-q2-2026' },
                      name: { type: 'string', example: 'Post-Transaction Satisfaction Survey' },
                      mode: { type: 'string', example: 'manual' },
                    },
                  },
                },
              },
            },
          },
        },
        '400': {
          description: 'Validation failed — missing required fields or invalid question type',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string', example: 'validation_failed' },
                  details: { type: 'object' },
                },
              },
            },
          },
        },
        '500': { description: 'Failed to create survey' },
      },
    },
  },

  '/admin/survey/{surveyId}/archive': {
      delete: {
        summary: 'Archive a survey',
        tags: ['Admin - AI/Manual Survey'],
        description: `
          Soft deletes (archives) a survey without removing it from the database.

          This operation:
          - Sets is_archived = true
          - Records archived_at timestamp
          - Preserves survey definitions
          - Preserves survey responses
          - Preserves survey sessions
          - Maintains audit history

          Archived surveys are hidden from normal survey listings
          but can be restored later using the unarchive endpoint.

          Typical use cases:
          - Retiring obsolete surveys
          - Regulatory audit compliance
          - Preventing further survey usage
          - Administrative cleanup without data loss
        `,
        parameters: [
          {
            name: 'surveyId',
            in: 'path',
            required: true,
            schema: {
              type: 'string'
            }
          }
        ],
        responses: {
          '200': {
            description: 'Survey archived successfully'
          },
          '404': {
            description: 'Survey not found or already archived'
          },
          '500': {
            description: 'Failed to archive survey'
          }
        }
      }
    },

    '/admin/survey/{surveyId}/unarchive': {
      patch: {
        summary: 'Restore an archived survey',
        tags: ['Admin - AI/Manual Survey'],
        description: `
          Restores a previously archived survey.

          This operation:
          - Sets is_archived = false
          - Clears archived_at timestamp
          - Makes the survey visible again
          - Allows the survey to be reused

          Survey data, responses, and sessions remain unchanged.
        `,
        parameters: [
          {
            name: 'surveyId',
            in: 'path',
            required: true,
            schema: {
              type: 'string'
            }
          }
        ],
        responses: {
          '200': {
            description: 'Survey restored successfully'
          },
          '404': {
            description: 'Survey not found or not archived'
          },
          '500': {
            description: 'Failed to restore survey'
          }
        }
      }
    },


  '/admin/survey/{surveyId}': {

    patch: {

      summary: 'Edit a manual survey by survey ID',

      tags: ['Admin - AI/Manual Survey'],

      description: `

      Updates an existing **manual** survey definition.

      Editable fields:
      - name
      - questions

      Notes:
      - survey ID is taken from the path and cannot be changed.
      - only surveys with mode = manual are allowed on this endpoint.
      - provide at least one editable field.

    `,

      parameters: [

        {

          name: 'surveyId',

          in: 'path',

          required: true,

          schema: { type: 'string' }

        }

      ],

      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string', example: 'Updated CSAT Survey' },
                questions: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/SurveyQuestion' }
                }
              }
            }
          }
        }
      },

      responses: {

        '200': { description: 'Survey updated successfully' },

        '400': { description: 'Validation failed or survey mode is not manual' },

        '404': { description: 'Survey not found' },

        '500': { description: 'Failed to update survey' }

      }

    },

    delete: {

      summary: 'Delete a survey and its associated data',

      tags: ['Admin - AI/Manual Survey'],

      description: `

      Deletes all data associated with a survey, including:
      - Survey definition
      - Survey responses
      - Survey sessions (progress tracking)

      This is a destructive operation and should be used with caution.

      Typical use cases:
      - Data cleanup
      - Retesting environments
      - Removing obsolete surveys

    `,

    parameters: [

      {

        name: 'surveyId',

        in: 'path',

        required: true,

        schema: { type: 'string' }

      }

    ],

    responses: {

      '200': { description: 'Survey deleted successfully' },

      '404': { description: 'Survey not found' },

      '500': { description: 'Failed to delete survey data' }

    }

  }
  },

  '/admin/surveys': {
    get: {
      summary: 'Get surveys',
      tags: ['Admin - AI/Manual Survey'],
      description: `
        Retrieves survey definitions from the surveys table.

        Supports filtering by:
        - mode (ai, manual, meta)
        - status (active, inactive, draft)
        - archive state (archived or active records)

        Behavior:
        - Returns a list of surveys.
        - Use /admin/surveys/:surveyId for single survey retrieval.

        Examples:
        - GET /admin/surveys?mode=manual&status=active
        - GET /admin/surveys?mode=meta&archived=true
      `,
      parameters: [
        {
          name: 'mode',
          in: 'query',
          required: false,
          schema: {
            type: 'string',
            enum: ['ai', 'manual', 'meta']
          }
        },
        {
          name: 'status',
          in: 'query',
          required: false,
          schema: {
            type: 'string',
            enum: ['active', 'inactive', 'draft']
          }
        },
        {
          name: 'archived',
          in: 'query',
          required: false,
          schema: {
            type: 'boolean'
          }
        }
      ],
      responses: {
        '200': {
          description: 'Surveys retrieved successfully',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  count: { type: 'integer' },
                  surveys: {
                    type: 'array',
                    items: {
                      type: 'object'
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },

  '/admin/survey/{surveyId}/participants': {
    get: {
      summary: 'Get survey participants',
      tags: ['Admin - AI/Manual Survey'],
      description: `
      Returns a list of unique customer phone numbers who have participated in a given survey.

      Data is retrieved from stored survey responses in the database.
      Useful for:
      - Analytics
      - Retargeting campaigns
      - Follow-up engagement
      `,
      parameters: [
        {
          name: 'surveyId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        }
        ,
        {
          name: 'status',
          in: 'query',
          required: false,
          description: "Filter sessions by status. One of: active, completed, abandoned",
          schema: { type: 'string', enum: ['active','completed','abandoned'] }
        }
      ],
      responses: {
        '200': {
          description: 'Sessions with participant phone lists',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  surveyId: { type: 'string' },
                  sessions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        sessionId: { type: 'string' },
                        phones: { type: 'array', items: { type: 'string' } }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },

  '/admin/escalations': {
    get: {
      summary: 'Get escalations',
      tags: ['Admin - Escalation'],
      description: `
        Returns a list of escalations (human handoff / tickets).

        Supports filtering by:
        - status (pending, completed)
        - archive state (active or archived records)

        Use cases:
        - Monitor active support tickets
        - Review completed escalations
        - Access archived historical tickets
      `,
      parameters: [
        {
          name: 'status',
          in: 'query',
          required: false,
          description: 'Filter by ticket status',
          schema: {
            type: 'string',
            enum: ['pending', 'completed']
          }
        },
        {
          name: 'archived',
          in: 'query',
          required: false,
          description: 'Filter by archive state',
          schema: {
            type: 'boolean'
          }
        }
      ],
      responses: {
        '200': {
          description: 'List of escalations',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  escalations: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'integer' },
                        ticket_id: { type: 'string' },
                        message: { type: 'string' },
                        category: {
                          type: 'string',
                          enum: ['complaint', 'enquiry', 'request']
                        },
                        ticket_status: {
                          type: 'string',
                          enum: ['pending', 'completed']
                        },
                        is_archived: { type: 'boolean' },
                        archived_at: {
                          type: 'string',
                          format: 'date-time',
                          nullable: true
                        },
                        customer_phone: { type: 'string' },
                        user_account_number: { type: 'string', nullable: true },
                        human_agent_active: { type: 'boolean' },
                        handoff_phone: { type: 'string', nullable: true },
                        human_engaged_at: {
                          type: 'string',
                          format: 'date-time',
                          nullable: true
                        },
                        created_at: { type: 'string', format: 'date-time' },
                        updated_at: { type: 'string', format: 'date-time' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },

  '/admin/escalation/{ticketId}/status': {
    post: {
    summary: 'Update escalation status and optionally notify customer',
    tags: ['Admin - Escalation'],
    description: `
    Updates an escalation ticket status and optionally sends a WhatsApp notification.
    Supported operations:
    - Mark ticket as completed
    - Reopen ticket (pending)
    - Silent status update (no customer notification)
    - Send a normal WhatsApp text message
    - Send a WhatsApp template message
    Notification modes:
    1. Plain Text Message
      - Provide \`message\`
      - Leave \`templateId\` empty
    2. WhatsApp Template Message
      - Provide \`templateId\`
      - Provide \`templateData\` when the template contains placeholders
      - Leave \`message\` empty
    If \`sendMessage\` is false, the ticket status is updated without sending any WhatsApp notification.
    `,
    parameters: [
      {
        name: 'ticketId',
        in: 'path',
        required: true,
        schema: {
          type: 'string'
        },
        description: 'Escalation ticket identifier'
      }
    ],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['ticketStatus'],
            properties: {
              ticketStatus: {
                type: 'string',
                enum: ['pending', 'completed'],
                example: 'completed',
                description:
                  'New status to assign to the escalation ticket'
              },
              sendMessage: {
                type: 'boolean',
                default: false,
                example: true,
                description:
                  'When true, a WhatsApp notification is sent to the customer'
              },
              to: {
                type: 'string',
                example: '+2348012345678',
                description:
                  'Customer phone number. Required when sendMessage=true.'
              },
              message: {
                type: 'string',
                example:
                  'Your issue has been resolved successfully.',
                description:
                  'Plain WhatsApp text message. Used only when templateId is not supplied.'
              },
              templateId: {
                type: 'string',
                example: 'ticketnotice',
                description:
                  'Approved WhatsApp template name. When supplied, a template message is sent instead of a plain text message.'
              },
              templateData: {
                type: 'object',
                description:
                  'Values used to populate WhatsApp template placeholders.',
                properties: {
                  header: {
                    type: 'array',
                    items: {
                      type: 'string'
                    },
                    example: ['ESC-12345'],
                    description:
                      'Header placeholder values ({{1}}, {{2}}, etc.)'
                  },
                  body: {
                    type: 'array',
                    items: {
                      type: 'string'
                    },
                    example: [
                      'John Doe',
                      'Your ticket has been resolved'
                    ],
                    description:
                      'Body placeholder values ({{1}}, {{2}}, etc.)'
                  },
                  buttons: {
                    type: 'array',
                    items: {
                      type: 'string'
                    },
                    example: ['ESC-12345'],
                    description:
                      'Dynamic URL/button placeholder values'
                  }
                }
              }
            }
          },
         examples: {
          textMessage: {
            summary: 'Update ticket and send plain text message',
            value: {
              ticketStatus: 'completed',
              sendMessage: true,
              to: '+2348012345678',
              message:
                'Your issue has been resolved successfully.'
            }
          },
          templateMessageSingleHeaderVariable: {
            summary:
              'Send template with a single header variable',
            value: {
              ticketStatus: 'completed',
              sendMessage: true,
              to: '+2348012345678',
              templateId: 'ticketnotice',
              templateData: {
                header: ['ESC-12345']
              }
            }
          },

          templateMessageHeaderAndBodyVariables: {
            summary:
              'Send template with header and body variables',
            value: {
              ticketStatus: 'completed',
              sendMessage: true,
              to: '+2348012345678',
              templateId: 'ticket_resolved',
              templateData: {
                header: ['ESC-12345'],
                body: [
                  'John Doe',
                  'ESC-12345',
                  'Your issue has been resolved successfully.'
                ]
              }
            }
          },

          templateMessageMultipleBodyVariables: {
            summary:
              'Send template with multiple body placeholders',
            value: {
              ticketStatus: 'completed',
              sendMessage: true,
              to: '+2348012345678',
              templateId: 'ticket_update',
              templateData: {
                body: [
                  'John Doe',
                  'ESC-12345',
                  'Resolved',
                  'REF-001',
                  'Support Team'
                ]
              }
            }
          },

          templateMessageWithButtonVariables: {
            summary:
              'Send template with dynamic URL/button placeholders',
            value: {
              ticketStatus: 'completed',
              sendMessage: true,
              to: '+2348012345678',
              templateId: 'ticket_portal_link',
              templateData: {
                header: ['ESC-12345'],
                body: [
                  'John Doe'
                ],
                buttons: [
                  'ESC-12345'
                ]
              }
            }
          },

          reopenTicketAndNotifyCustomer: {
            summary:
              'Reopen ticket and notify customer using a template',
            value: {
              ticketStatus: 'pending',
              sendMessage: true,
              to: '+2348012345678',
              templateId: 'ticket_reopened',
              templateData: {
                header: ['ESC-12345'],
                body: [
                  'John Doe',
                  'Your ticket has been reopened and is under review.'
                ]
              }
            }
          },

          silentUpdate: {
            summary: 'Update ticket without notification',
            value: {
              ticketStatus: 'completed',
              sendMessage: false
            }
          }
        }
        }
      }
    },
    responses: {
      '200': {
        description:
          'Escalation status updated successfully'
      },
      '400': {
        description:
          'Invalid request payload or validation error'
      },
      '404': {
        description:
          'Escalation ticket not found'
      },
      '500': {
        description:
          'Failed to update escalation'
      }
    }}},

  '/admin/escalation/{ticketId}/message': {
  post: {
    summary: 'Send human agent message',
    tags: ['Admin - Escalation'],
    description: `
Sends a WhatsApp message to a customer for an active escalation.

Useful for:
- Allowing a human agent to continue a conversation after AI handoff
- Replying from an admin/support console
- Sending approved WhatsApp template notifications

The first successful human reply automatically marks the escalation as human-owned,
preventing the AI assistant from responding further.

Supported message types:

1. Plain Text Message
   - Provide \`to\`
   - Provide \`message\`
   - Do NOT provide \`templateId\`

2. WhatsApp Template Message
   - Provide \`to\`
   - Provide \`templateId\`
   - Optionally provide \`templateData\`
   - Do NOT provide \`message\`
`,

    parameters: [
      {
        name: 'ticketId',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
        description: 'Escalation ticket identifier',
      },
    ],

    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['to'],

            properties: {
              to: {
                type: 'string',
                example: '+2348012345678',
                description:
                  'WhatsApp phone number that will receive the message.',
              },

              message: {
                type: 'string',
                example:
                  'Hello, this is Ada from FBNBank support. I am now handling your request.',
                description:
                  'Plain WhatsApp text message. Cannot be used together with templateId.',
              },

              templateId: {
                type: 'string',
                example: 'ticketnotice',
                description:
                  'Approved WhatsApp template identifier. Cannot be used together with message.',
              },

              templateData: {
                type: 'object',
                description:
                  'Placeholder values for WhatsApp template variables.',

                properties: {
                  header: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                    example: ['ESC-12345'],
                    description:
                      'Header placeholder values ({{1}}, {{2}}, etc.)',
                  },

                  body: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                    example: [
                      'John Doe',
                      'ESC-12345',
                      'Your issue has been resolved successfully.',
                    ],
                    description:
                      'Body placeholder values ({{1}}, {{2}}, etc.)',
                  },

                  buttons: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                    example: ['ESC-12345'],
                    description:
                      'Dynamic button or URL placeholder values.',
                  },
                },
              },
            },
          },

          examples: {
            humanReply: {
              summary: 'Send plain WhatsApp text message',
              value: {
                to: '+2348012345678',
                message:
                  'Hello, this is Ada from FBNBank support. I am now handling your request.',
              },
            },

            templateMessageSingleHeaderVariable: {
              summary: 'Send template with header variable',
              value: {
                to: '+2348012345678',
                templateId: 'ticketnotice',
                templateData: {
                  header: ['ESC-12345'],
                },
              },
            },

            templateMessageHeaderAndBodyVariables: {
              summary: 'Send template with header and body variables',
              value: {
                to: '+2348012345678',
                templateId: 'ticket_resolved',
                templateData: {
                  header: ['ESC-12345'],
                  body: [
                    'John Doe',
                    'ESC-12345',
                    'Your issue has been resolved successfully.',
                  ],
                },
              },
            },

            templateMessageMultipleBodyVariables: {
              summary: 'Send template with multiple body placeholders',
              value: {
                to: '+2348012345678',
                templateId: 'ticket_update',
                templateData: {
                  body: [
                    'John Doe',
                    'ESC-12345',
                    'Resolved',
                    'REF-001',
                    'Support Team',
                  ],
                },
              },
            },

            templateMessageWithButtonVariables: {
              summary: 'Send template with button variables',
              value: {
                to: '+2348012345678',
                templateId: 'ticket_portal_link',
                templateData: {
                  header: ['ESC-12345'],
                  body: ['John Doe'],
                  buttons: ['ESC-12345'],
                },
              },
            },
          },
        },
      },
    },

    responses: {
      '200': {
        description: 'Human agent message sent successfully',
      },

      '400': {
        description:
          'Validation error. Either message or templateId must be supplied, but not both.',
      },

      '404': {
        description: 'Escalation not found',
      },

      '409': {
        description: 'Escalation is no longer active',
      },

      '502': {
        description: 'WhatsApp delivery failed',
      },

      '500': {
        description: 'Failed to send human agent message',
      },
    },
  },
},

  '/admin/escalation/message': {
    post: {
      summary: 'Send spontaneous WhatsApp message(s)',
      tags: ['Admin - Escalation'],
      description: `
      Sends spontaneous WhatsApp messages without requiring an escalation ticket.

      Useful for:
      - Proactive customer outreach
      - Human support follow-ups
      - Operational notifications
      - Sending approved WhatsApp template messages
      - Bulk messaging to multiple recipients

      Supported message types:
      1. Plain Text Message
        - Provide \`message\`
        - Leave \`templateId\` empty
      2. WhatsApp Template Message
        - Provide \`templateId\`
        - Provide \`templateData\` if the template contains placeholders
        - Leave \`message\` empty
      The same message/template is sent to every recipient in the \`to\` array.
      `,

      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',

              required: ['to'],

              properties: {
                message: {
                  type: 'string',
                  example: 'Hello customer',
                  description:
                    'Plain WhatsApp text message. Used only when templateId is not supplied.'
                },

                templateId: {
                  type: 'string',
                  example: 'ticketnotice',
                  description:
                    'Approved WhatsApp template name.'
                },

                templateData: {
                  type: 'object',
                  description:
                    'Values used to populate WhatsApp template placeholders.',

                  properties: {
                    header: {
                      type: 'array',
                      items: {
                        type: 'string'
                      },
                      example: ['ESC-12345'],
                      description:
                        'Header placeholder values ({{1}}, {{2}}, etc.)'
                    },

                    body: {
                      type: 'array',
                      items: {
                        type: 'string'
                      },
                      example: [
                        'John Doe',
                        'ESC-12345',
                        'Your issue has been resolved'
                      ],
                      description:
                        'Body placeholder values ({{1}}, {{2}}, etc.)'
                    },

                    buttons: {
                      type: 'array',
                      items: {
                        type: 'string'
                      },
                      example: ['ESC-12345'],
                      description:
                        'Dynamic URL/button placeholder values'
                    }
                  }
                },

                to: {
                  type: 'array',
                  minItems: 1,

                  items: {
                    type: 'string'
                  },

                  example: [
                    '+2348012345678',
                    '+2348098765432'
                  ],

                  description:
                    'List of recipient phone numbers.'
                }
              }
            },

            examples: {
              textMessage: {
                summary:
                  'Send a plain text message to multiple customers',
                value: {
                  to: [
                    '+2348012345678',
                    '+2348098765432'
                  ],
                  message:
                    'Our support team will contact you shortly.'
                }
              },

              templateMessageSingleHeaderVariable: {
                summary:
                  'Send template with a single header variable',
                value: {
                  to: [
                    '+2348012345678'
                  ],
                  templateId: 'ticketnotice',
                  templateData: {
                    header: [
                      'ESC-12345'
                    ]
                  }
                }
              },

              templateMessageHeaderAndBodyVariables: {
                summary:
                  'Send template with header and body variables',
                value: {
                  to: [
                    '+2348012345678'
                  ],
                  templateId: 'ticket_resolved',
                  templateData: {
                    header: [
                      'ESC-12345'
                    ],
                    body: [
                      'John Doe',
                      'ESC-12345',
                      'Your issue has been resolved successfully.'
                    ]
                  }
                }
              },

              templateMessageMultipleBodyVariables: {
                summary:
                  'Send template with multiple body placeholders',
                value: {
                  to: [
                    '+2348012345678'
                  ],
                  templateId: 'ticket_update',
                  templateData: {
                    body: [
                      'John Doe',
                      'ESC-12345',
                      'Resolved',
                      'REF-001',
                      'Support Team'
                    ]
                  }
                }
              },

              templateMessageWithButtonVariables: {
                summary:
                  'Send template with dynamic URL/button placeholders',
                value: {
                  to: [
                    '+2348012345678'
                  ],
                  templateId: 'ticket_portal_link',
                  templateData: {
                    header: [
                      'ESC-12345'
                    ],
                    body: [
                      'John Doe'
                    ],
                    buttons: [
                      'ESC-12345'
                    ]
                  }
                }
              }
            }
          }
        }
      },

      responses: {
        '200': {
          description:
            'Message sent successfully to at least one recipient'
        },

        '400': {
          description:
            'Invalid request payload or validation error'
        },

        '502': {
          description:
            'Message delivery failed for all recipients'
        },

        '500': {
          description:
            'Failed to send spontaneous WhatsApp message'
        }
      }
      }
      },

  '/admin/escalation/{ticketId}/messages': {
    get: {
      summary: 'Get escalation messages',
      tags: ['Admin - Escalation'],
      description: `
      Returns inbound and outbound messages linked to an escalation ticket.

      Useful for:
      - Letting backend human-support consoles fetch customer replies during handoff
      - Auditing the human-agent conversation trail for a ticket
      `,
      parameters: [
        {
          name: 'ticketId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        },
        {
          name: 'direction',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['inbound', 'outbound'] },
          description: 'Optional direction filter'
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          description: 'Maximum number of messages to return'
        }
      ],
      responses: {
        '200': { description: 'Escalation messages retrieved successfully' },
        '400': { description: 'Invalid request query parameters' },
        '404': { description: 'Escalation not found' },
        '500': { description: 'Failed to fetch escalation messages' }
      }
    }
  },

  '/admin/escalation/{ticketId}/release': {
    post: {
      summary: 'Release human handoff',
      tags: ['Admin - Escalation'],
      description: `
      Returns control of a pending escalation back to the AI without closing the ticket.

      Useful for:
      - Handing the conversation back to the bot when the human agent is done for now
      - Avoiding clashes when a human agent cannot continue immediately
      `,
      parameters: [
        {
          name: 'ticketId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        }
      ],
      responses: {
        '200': { description: 'Human handoff released successfully' },
        '404': { description: 'Escalation not found' },
        '409': { description: 'Escalation is already completed' },
        '500': { description: 'Failed to release human handoff' }
      }
    }
  },

  '/admin/chat-history/messages': {
    get: {
      summary: 'Get detailed chat history',
      tags: ['Admin - Chat History'],
      description: `
      Returns detailed chat history records across Customer, AI, and Human roles.

      Filters supported:
      - threadId (phone/thread)
      - role (AI, Human, Customer)
      - escalationId
      - from/to datetime range
      - limit/offset pagination
      `,
      parameters: [
        { name: 'threadId', in: 'query', required: false, schema: { type: 'string' }, description: 'Phone/thread id to filter by' },
        { name: 'role', in: 'query', required: false, schema: { type: 'string', enum: ['AI', 'Human', 'Customer'] }, description: 'Message role filter' },
        { name: 'escalationId', in: 'query', required: false, schema: { type: 'string' }, description: 'Escalation ticket id filter' },
        { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Include records from this timestamp' },
        { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Include records up to this timestamp' },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 }, description: 'Maximum number of messages to return' },
        { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 }, description: 'Pagination offset' }
      ],
      responses: {
        '200': { description: 'Detailed chat history fetched successfully' },
        '400': { description: 'Invalid query parameters' },
        '500': { description: 'Failed to fetch chat history messages' }
      }
    }
  },

  '/admin/chat-history/threads': {
    get: {
      summary: 'Get chat history threads summary',
      tags: ['Admin - Chat History'],
      description: `
      Returns thread-level chat history summary with role counts and timestamps.

      Useful for dashboards, inbox views, and selecting active customer conversations.
      Supports the same filters as detailed history.
      `,
      parameters: [
        { name: 'threadId', in: 'query', required: false, schema: { type: 'string' }, description: 'Phone/thread id to filter by' },
        { name: 'role', in: 'query', required: false, schema: { type: 'string', enum: ['AI', 'Human', 'Customer'] }, description: 'Filter threads having this role in range' },
        { name: 'escalationId', in: 'query', required: false, schema: { type: 'string' }, description: 'Escalation ticket id filter' },
        { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Include records from this timestamp' },
        { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Include records up to this timestamp' },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 }, description: 'Maximum number of thread summaries to return' },
        { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 }, description: 'Pagination offset' }
      ],
      responses: {
        '200': { description: 'Thread summaries fetched successfully' },
        '400': { description: 'Invalid query parameters' },
        '500': { description: 'Failed to fetch chat history threads' }
      }
    }
  },

  '/admin/escalation/{ticketId}': {
    delete: {
      summary: 'Archive escalation',
      tags: ['Admin - Escalation'],
      description: `
      Archives an escalation (human handoff / ticket) in the database.

      Useful for:
      - Removing completed tickets
      - Cleaning up old escalations
      `,
      parameters: [
        {
          name: 'ticketId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        }
      ],
      responses: {
        '200': { description: 'Escalation archived successfully' },
        '404': { description: 'The escalation with this ID is not found. Probably deleted' },
        '500': { description: 'Failed to archive escalation' }
      }
    }
  },

  '/admin/escalation/{ticketId}/purge': {
      delete: {
        summary: 'Permanently delete a completed escalation',
        tags: ['Admin - Escalation'],
        description: `
          Permanently deletes an escalation ticket from the database.

          ⚠️ This is a destructive operation and cannot be undone.

          Rules:
          - Only escalations with status = "completed" can be deleted
          - Active or pending escalations cannot be purged
          - This removes all data permanently (no archive/recovery)
        `,
        parameters: [
          {
            name: 'ticketId',
            in: 'path',
            required: true,
            schema: {
              type: 'string'
            },
            description: 'Unique escalation ticket ID'
          }
        ],
        responses: {
          '200': {
            description: 'Escalation permanently deleted',
            content: {
              'application/json': {
                example: {
                  success: true,
                  ticketId: 'TICKET_123',
                  deleted: true
                }
              }
            }
          },
          '400': {
            description: 'Invalid request or ticket not eligible for deletion'
          },
          '404': {
            description: 'Escalation not found'
          },
          '500': {
            description: 'Server error while deleting escalation'
          }
        }
      }
  },


  '/admin/escalation/{ticketId}/unarchive': {
    patch: {
      summary: 'Restore an archived escalation',
      tags: ['Admin - Escalation'],
      description: `
        Restores an archived escalation back to active state.

        This operation:
        - Sets is_archived = false
        - Clears archived_at timestamp
        - Makes the escalation visible again in active lists

        Note:
        - Only archived escalations can be restored
        - Original ticket data is unchanged
      `,
      parameters: [
        {
          name: 'ticketId',
          in: 'path',
          required: true,
          schema: {
            type: 'string'
          },
          description: 'Escalation ticket ID'
        }
      ],
      responses: {
        '200': {
          description: 'Escalation restored successfully',
          content: {
            'application/json': {
              example: {
                success: true,
                ticketId: 'TICKET_123',
                restored: true
              }
            }
          }
        },
        '404': {
          description: 'Escalation not found or not archived'
        },
        '500': {
          description: 'Server error while restoring escalation'
        }
      }
    }
  },

  '/admin/escalations/archived': {
    get: {
      summary: 'Get all archived escalations',
      tags: ['Admin - Escalation'],
      description: `
        Returns all escalations that have been archived.

        Use cases:
        - Audit review
        - Historical support tracking
        - Compliance reporting

        Only returns:
        - is_archived = true records
      `,
      responses: {
        '200': {
          description: 'List of archived escalations',
          content: {
            'application/json': {
              example: {
                count: 2,
                escalations: [
                  {
                    ticket_id: 'TICKET_123',
                    ticket_status: 'completed',
                    is_archived: true,
                    archived_at: '2026-06-03T10:00:00Z'
                  }
                ]
              }
            }
          }
        },
        '500': {
          description: 'Server error while fetching archived escalations'
        }
      }
    }
  },

  '/api/agent/chat': {
    post: {
      summary: 'Chat with the Engagement Agent (testing)',
      description: 'Send a message to the FBNBank Senegal engagement agent and receive a reply. Uses thread-based memory keyed on `phone`.',
      tags: ['Agent'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['message'],
              properties: {
                message: { type: 'string', description: 'The customer message to send to the agent', example: 'Bonjour' },
                phone: { type: 'string', description: 'Phone number used as the memory thread key (optional, defaults to "test-user")', example: '+221770000000' },
                contactName: { type: 'string', description: 'Optional customer display name', example: 'Amadou' },
              }
            }
          }
        }
      },
      responses: {
        '200': {
          description: 'Agent reply',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  reply: { type: 'string' }
                }
              }
            }
          }
        },
        '400': { description: 'Missing message field' },
        '500': { description: 'Agent error' }
      }
    }
  },

  // ─── Agent Memory Reset ──────────────────────────────────────────────────
  '/api/agent/reset': {
    post: {
      summary: 'Global reset of all agent memory threads',
      tags: ['Agent'],
      description: `
      Accesses Mastra's primary storage subsystem to clear the memory of all agents completely. 

      This endpoint operates without any input body parameters. It sweeps the entire 'memory' store domain, pulls all active conversation threads, and hard-deletes them sequentially.

      **Cascading effects:**
      - Purges all historical text messages, observations, and system reflections.
      - Sanitizes connected vector databases of orphaned context records to prevent long-term token pollution.
      `,
      responses: {
        '200': {
          description: 'Successfully cleared all conversation threads across all operational agents.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: true },
                  message: { type: 'string', example: 'Successfully reset agent states. Cleared all 12 active conversation threads across all agents.' }
                }
              }
            }
          }
        },
        '404': {
          description: 'Mastra storage layer or memory domain failed to initialize.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: false },
                  error: { type: 'string', example: 'Mastra storage provider is not configured or initialized.' }
                }
              }
            }
          }
        },
        '500': {
          description: 'Database exception or cascade deletion pipe error.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean', example: false },
                  error: { type: 'string', example: 'Internal server error during memory cleanup' }
                }
              }
            }
          }
        }
      }
    }
  },

  // feedback survey route
  

  '/api/kb/upload': {
    post: {
      summary: 'Upload document(s) to knowledge base',
      tags: ['Knowledge Base'],
      description: 'Uploads one or more files (PDF, TXT, CSV, DOCX, DOC, XLSX) or raw text to the knowledge base. Each document is chunked, embedded, and stored in the vector index.',
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                files: { type: 'array', items: { type: 'string', format: 'binary' }, description: 'PDF, TXT, CSV, DOCX, DOC, or XLSX files' },
                text: { type: 'string', description: 'Raw text to ingest directly' },
                title: { type: 'string', description: 'Optional document title' }
              }
            }
          }
        }
      },
      responses: {
        '200': { description: 'Documents ingested successfully' },
        '400': { description: 'No file or text provided' },
        '500': { description: 'Ingestion failed' }
      }
    }
  },

  '/api/kb/docs': {
    get: {
      summary: 'List all knowledge base documents',
      tags: ['Knowledge Base'],
      description: 'Returns metadata for all documents currently in the knowledge base index.',
      responses: {
        '200': {
          description: 'List of document metadata',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  docs: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        doc_id: { type: 'string' },
                        title: { type: 'string' },
                        original_name: { type: 'string' },
                        size: { type: 'integer' },
                        uploaded_at: { type: 'string', format: 'date-time' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },

  '/api/kb/docs/{docId}': {
    get: {
      summary: 'Get knowledge base document by ID',
      tags: ['Knowledge Base'],
      parameters: [{ name: 'docId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Document metadata' },
        '404': { description: 'Document not found' }
      }
    },
    delete: {
      summary: 'Delete a document from the knowledge base',
      tags: ['Knowledge Base'],
      description: 'Removes the document vectors, the uploaded file, and the metadata record.',
      parameters: [{ name: 'docId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Document deleted successfully' },
        '404': { description: 'Document not found' },
        '500': { description: 'Deletion failed' }
      }
    }
  },

  '/': {
    get: {
      summary: 'Health check',
      description: 'Returns a simple liveness confirmation that the server is up and running.',
      tags: ['Health'],
      responses: {
        '200': {
          description: 'Server is running',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string', example: 'I am alive!' }
                }
              }
            }
          }
        }
      }
    }
  }

}
}

const swaggerApiKeySecurity = [{ ApiKeyAuth: [] }];
for (const [path, operations] of Object.entries(swaggerDocument.paths as Record<string, any>)) {
  const requiresApiKey = path.startsWith('/admin/') || path.startsWith('/api/kb/');
  if (!requiresApiKey) continue;

  for (const [method, operation] of Object.entries(operations as Record<string, any>)) {
    if (!operation || typeof operation !== 'object') continue;

    const normalizedMethod = method.toLowerCase();
    if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(normalizedMethod)) {
      operation.security = swaggerApiKeySecurity;
    }
  }
}





app.get("/", (_req: Request, res: Response) => {
  res.json({ message: "I am alive!" });
});


if (enableSwagger) {
  app.use('/api-docs', (swaggerUi.serve as any), (swaggerUi.setup(swaggerDocument) as any));
} else {
  console.log('Swagger UI is not available');
}


// WhatsApp Webhook: Verification
app.get('/webhook/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      const challengeValue = typeof challenge === 'string' ? challenge : '';
      const isValidChallenge = /^[A-Za-z0-9._-]{1,200}$/.test(challengeValue);
      if (!isValidChallenge) {
        return res.sendStatus(400);
      }
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).type('text/plain').send(challengeValue);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
});



app.post('/webhook/whatsapp', async (req: Request, res: Response) => {
  const body = req.body;

  try {
    if (!body.object) {
      return res.sendStatus(404);
    }

    // Handle message status events (delivery/read) if present
    const statuses = body?.entry?.[0]?.changes?.[0]?.value?.statuses;
    if (statuses && Array.isArray(statuses) && statuses.length > 0) {
      console.log('📣 Received message statuses:', JSON.stringify(statuses, null, 2));
      // Could update DB with delivery/read receipts here
      return res.sendStatus(200);
    }

    const changeValue = body?.entry?.[0]?.changes?.[0]?.value;
    const message = changeValue?.messages?.[0];
    // Try to extract the contact/profile name from the Meta webhook payload
    const contacts = changeValue?.contacts;
    const phoneNumberId: string | undefined = changeValue?.metadata?.phone_number_id || undefined;
    const contactName = Array.isArray(contacts) && contacts.length > 0
      ? (contacts[0]?.profile?.name || contacts[0]?.name || contacts[0]?.pushname || null)
      : null;

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const messageId: string = message.id || '';

    if (messageId && isDuplicateInboundMessage(messageId)) {
      console.log(`↩️ Skipping duplicate inbound message ${messageId}`);
      return res.sendStatus(200);
    }

    console.log(`📩 Incoming message from ${from}`);
    console.log(JSON.stringify(message, null, 2));

    // Mark the incoming message as read immediately (turns grey ticks blue)
    if (messageId) {
      sendWhatsAppReadReceipt({ messageId, phoneNumberId }).catch(() => {});
    }

    //  Get DB + mastra
    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) {
      throw new Error('DB not initialized');
    }

    //  Call your router (THIS is the key line)
    await routeIncomingMessage({
      db,
      mastra: mastra as any,
      message,
      phone: from,
      contactName,
      messageId,
      phoneNumberId,
      lastOutboundType,

      sendMessage: async (to: string, msg: string) => {
        // mark last outbound as chat
        setLastOutbound(String(to), 'chat');

        await sendWhatsAppMessage({ to, message: msg, phoneNumberId });

        try {
          const threadId = normalizePhone(String(to));
          const pendingEscalation = await escalationService.getLatestActiveEscalationByPhone(db, threadId);
          await chatHistoryService.logChatMessage({
            db,
            threadId,
            role: 'AI',
            messageText: msg,
            escalationId: pendingEscalation?.ticket_id || null,
          });
        } catch (err) {
          console.error('Failed to log outbound AI chat message', err);
        }
      },

      sendQuestion: async (to: string, question: any, session: any) => {
        // mark last outbound as survey question
        setLastOutbound(String(to), 'survey_question');

        // Handle text-only question
        if (!question.options || question.options.length === 0) {
          await sendWhatsAppMessage({
            to,
            message: question.question || question.text || "Please provide your response:",
            phoneNumberId,
          });
          return;
        }

        // Handle interactive (buttons)
        await sendWhatsAppSurvey({
          to,
          surveyId: session.survey_id,
          question: question.question,
          options: question.options,
          phoneNumberId,
        });
      },
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    return res.sendStatus(500);
  }
});




// ---------------- Admin endpoints ----------------
// GET participants for a survey
// Returns an array of objects { sessionId, phones: [customer_phone, ...] }
// Each survey can have multiple sessions (re-sends); we group responses by session_id
app.get('/admin/survey/:surveyId/participants', async (req: Request, res: Response) => {
  const surveyId = req.params.surveyId;
  const status = (req.query?.status as string) || undefined;
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });
    // Validate status if provided
    const allowed = ['active','completed','abandoned'];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${allowed.join(',')}` });
    }

    // Group by session_id and collect distinct phones for each session
    let rows: any[] = [];
    if (status) {
      rows = await db.any(
        `SELECT r.session_id, array_agg(DISTINCT r.customer_phone) AS phones
         FROM survey_responses r
         JOIN survey_sessions s ON r.session_id = s.id
         WHERE r.survey_id = $1 AND s.status = $2
         GROUP BY r.session_id
         ORDER BY MAX(r.created_at) DESC`,
        [surveyId, status]
      );
    } else {
      rows = await db.any(
        `SELECT r.session_id, array_agg(DISTINCT r.customer_phone) AS phones
         FROM survey_responses r
         JOIN survey_sessions s ON r.session_id = s.id
         WHERE r.survey_id = $1
         GROUP BY r.session_id
         ORDER BY MAX(r.created_at) DESC`,
        [surveyId]
      );
    }

    const sessions = Array.isArray(rows)
      ? rows.map((r: any) => ({ sessionId: r.session_id, phones: r.phones || [] }))
      : [];

    return res.json({ surveyId, sessions });
  } catch (e) {
    console.error('Failed to fetch participants', e);
    return res.status(500).json({ error: 'failed' });
  }
});



// POST create/save a manual survey JSON into data/<surveyId>.json
const SurveyQuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  options: z.array(z.string()).optional(),
  type: z.enum(['button', 'list', 'text', 'multi']),
  sectionTitle: z.string().optional(),
  placeholder: z.string().optional(),
  allowMultiple: z.boolean().optional(),
  showIf: z.object({
    dependsOn: z.string(),
    equals: z.string(),
  }).optional(),
});

const SurveyTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  mode: z.enum(['manual', 'ai', 'meta']).default('manual'),
  questions: z.array(SurveyQuestionSchema),
});

const SurveyTemplateUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  questions: z.array(SurveyQuestionSchema).min(1).optional(),
}).refine((value) => value.name !== undefined || value.questions !== undefined, {
  message: 'Provide at least one editable field: name or questions',
});




app.post('/admin/survey', async (req: Request, res: Response) => {
  try {
    const body = req.body;

    const parse = SurveyTemplateSchema.safeParse(body);

    if (!parse.success) {
      return res.status(400).json({
        error: 'validation_failed',
        details: parse.error.format(),
      });
    }

    const survey = parse.data;

    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) {
      return res.status(500).json({
        error: 'DB not initialized',
      });
    }

    await db.query(
      `
      INSERT INTO surveys (
        id,
        name,
        mode,
        questions_data
      )
      VALUES ($1, $2, $3, $4)
      `,
      [
        survey.id,
        survey.name,
        survey.mode,
        JSON.stringify(survey.questions),
      ]
    );

    return res.status(201).json({
      success: true,
      survey: {
        id: survey.id,
        name: survey.name,
        mode: survey.mode,
      },
    });
  } catch (e) {
    console.error('Failed to create survey', e);

    if (e instanceof Error) {
      const pgError = e as any;

      // PostgreSQL duplicate key error
      if (pgError.code === '23505') {
        return res.status(409).json({
          error: 'duplicate_survey_id',
          message: `Survey with id "${req.body.id}" already exists. Please choose a different id.`,
        });
      }
    }

    return res.status(500).json({
      error: e instanceof Error ? e.message : 'internal_server_error',
    });
  }
});

app.get('/admin/surveys', async (req, res) => {
  const storage = mastra.getStorage() as any;
  const db = storage?.db;

  const { query, values } = buildAdminListQuery(
    `SELECT * FROM surveys`,
    {
      modeColumn: 'mode',
      statusColumn: 'status',
      archivedColumn: 'is_archived',
      filters: req.query as any,
    }
  );

  console.log('QUERY:', query);
  console.log('VALUES:', values);

  const result = await db.query(query, values);

  return res.json({
    count: result.rows.length,
    surveys: result.rows,
  });
});



app.delete('/admin/survey/:surveyId/archive', async (req, res) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) {
      throw new Error('Database not initialized');
    }

    const { surveyId } = req.params;

    const result = await db.query(
      `
      UPDATE surveys
      SET
        is_archived = TRUE,
        archived_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
      AND is_archived = FALSE
      RETURNING id, name
      `,
      [surveyId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'survey_not_found_or_already_archived',
      });
    }

    return res.json({
      success: true,
      message: `Survey ${surveyId} archived successfully`,
      survey: result.rows[0],
    });
  } catch (e) {
    console.error('Archive survey error:', e);

    return res.status(500).json({
      success: false,
      error: 'internal_server_error',
    });
  }
});



app.patch('/admin/survey/:surveyId/unarchive', async (req, res) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) {
      throw new Error('Database not initialized');
    }

    const { surveyId } = req.params;

    const result = await db.query(
      `
      UPDATE surveys
      SET
        is_archived = FALSE,
        archived_at = NULL,
        updated_at = NOW()
      WHERE id = $1
      AND is_archived = TRUE
      RETURNING id, name
      `,
      [surveyId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'survey_not_found_or_not_archived',
      });
    }

    return res.json({
      success: true,
      message: `Survey ${surveyId} restored successfully`,
      survey: result.rows[0],
    });
  } catch (e) {
    console.error('Unarchive survey error:', e);

    return res.status(500).json({
      success: false,
      error: 'internal_server_error',
    });
  }
});


app.patch('/admin/survey/:surveyId', async (req, res) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) {
      throw new Error('Database not initialized');
    }

    const { surveyId } = req.params;
    const body = req.body;

    const parsed = SurveyTemplateUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'validation_failed',
        details: parsed.error.format(),
      });
    }

    const existing = await db.query(
      `SELECT id, mode FROM surveys WHERE id = $1`,
      [surveyId]
    );

    if (existing.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'survey_not_found',
      });
    }

    const row = existing.rows[0];
    if (row.mode !== 'manual') {
      return res.status(400).json({
        success: false,
        error: 'invalid_survey_mode',
        message: `Only manual surveys can be updated from this endpoint. Survey mode is "${row.mode}".`,
      });
    }

    const { name, questions } = parsed.data;
    const updates: string[] = [];
    const values: any[] = [];

    if (name !== undefined) {
      values.push(name);
      updates.push(`name = $${values.length}`);
    }

    if (questions !== undefined) {
      values.push(JSON.stringify(questions));
      updates.push(`questions_data = $${values.length}`);
    }

    values.push(surveyId);

    const result = await db.query(
      `
      UPDATE surveys
      SET
        ${updates.join(', ')},
        updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING id, name, mode, questions_data, is_archived, updated_at
      `,
      values
    );

    return res.json({
      success: true,
      message: `Survey ${surveyId} updated successfully`,
      survey: result.rows[0],
    });
  } catch (e) {
    console.error('Update survey error:', e);

    return res.status(500).json({
      success: false,
      error: 'internal_server_error',
    });
  }
});


app.delete('/admin/survey/:surveyId', async (req, res) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) throw new Error("Database not initialized");

    const { surveyId } = req.params;

    // 1. Check if the survey exists first
    const check = await db.query('SELECT 1 FROM surveys WHERE id = $1', [surveyId]);
    
    if (check.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'survey_not_found',
        message: `No survey found with ID: ${surveyId}`
      });
    }

    // 2. Delete the survey
    // Note: If you used 'ON DELETE CASCADE' in your DB init script for foreign keys,
    // deleting from 'surveys' will automatically clean up 'survey_sessions' and 'survey_responses'.
    await db.query('DELETE FROM surveys WHERE id = $1', [surveyId]);

    console.log(`🗑️ Deleted survey: ${surveyId}`);

    return res.json({
      success: true,
      message: `Survey ${surveyId} and all associated data deleted successfully.`
    });

  } catch (e) {
    console.error('❌ Delete error:', e);
    return res.status(500).json({
      success: false,
      error: 'internal_server_error',
      details: e instanceof Error ? e.message : 'Unknown error'
    });
  }
});





app.get('/admin/escalations', async (req, res) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const { query, values } = buildAdminListQuery(
      `SELECT * FROM escalations`,
      {
        statusColumn: 'ticket_status',
        archivedColumn: 'is_archived',
        filters: req.query as any
      }
    );

    const result = await db.query(query, values);

    return res.json({
      count: result.rows.length,
      escalations: result.rows
    });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'failed' });
  }
});

app.post('/admin/escalation/:ticketId/message', async (req: Request, res: Response) => {
  try {
    const rawTicketId = req.params.ticketId;
    const ticketId = Array.isArray(rawTicketId) ? rawTicketId[0] : rawTicketId;

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId is required' });
    }
    const parse = z
    .object({
      to: z.string().trim().min(1),

      message: z.string().trim().optional(),

      templateId: z.string().trim().optional(),

      templateData: z.object({
        header: z.array(z.string()).optional(),
        body: z.array(z.string()).optional(),
        buttons: z.array(z.string()).optional(),
      }).optional(),
    })
    .superRefine((data, ctx) => {
      if (!data.message && !data.templateId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Either message or templateId is required',
        });
      }

      if (data.message && data.templateId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'message and templateId cannot both be provided',
        });
      }
    })
    .safeParse(req.body || {});

    if (!parse.success) {
      return res.status(400).json({ error: 'validation_failed', details: parse.error.format() });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const result = await escalationService.sendHumanAgentMessage({
      db,
      ticketId,
      message: parse.data.templateId ? `Message from human agent sent via template` : parse.data.message,
      to: parse.data.to,
      sendMessage: async (
        to: string,
        message: string
        ) =>
          sendWhatsAppMessageOrTemplate({
            to,
            message: parse.data.templateId
              ? undefined
              : message,
            templateId: parse.data.templateId,
            templateData: parse.data.templateData,
          }),
      });

    if (!result.sent) {
      return res.status(502).json({
        error: 'Failed to deliver human agent message to WhatsApp',
        ticketId,
        to: result.to,
      });
    }

    try {
      await chatHistoryService.logChatMessage({
        db,
        threadId: result.to,
        role: 'Human',
        messageText:
        parse.data.message ||
        `[Template:${parse.data.templateId}] ${JSON.stringify(
          parse.data.templateData || {}
        )}`,
        escalationId: ticketId,
      });

      broadcastEscalationMessage({
        ticketId,
        threadId: result.to,
        phone: result.to,
        direction: 'outbound',
        message: parse.data.message || `[Template:${parse.data.templateId}]`,
      });
    } catch (error) {
      console.error('Failed to log outbound human chat message', error);
    }

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err: any) {

    if (err.message === 'not_found') {
      return res.status(404).json({ error: 'The escalation with this ID is not found. Probably deleted' });
    }

    if (err.message === 'ticket_not_active') {
      return res.status(409).json({ error: 'Only pending escalations can receive human agent messages' });
    }

    console.error('Failed to send human agent message', err);
    return res.status(500).json({ error: 'Failed to send human agent message' });
  }
});


app.post('/admin/escalation/message', async (req: Request, res: Response) => {
  try { 
    const parse = z
      .object({
        message: z.string().trim().optional(),
        templateId: z.string().trim().optional(),
        templateData: z
          .object({
            header: z.array(z.string()).optional(),
            body: z.array(z.string()).optional(),
            buttons: z.array(z.string()).optional(),
          })
          .optional(),
        to: z.array(z.string().trim().min(1)).min(1),
      })
      .refine(
        (data) =>
          (data.message && data.message.length > 0) ||
          !!data.templateId,
        {
          message:
            'Either message or templateId is required',
        }
      )
      .safeParse(req.body || {});


    if (!parse.success) {
      return res.status(400).json({ error: 'validation_failed', details: parse.error.format() });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const recipients = Array.from(new Set(parse.data.to.map((n) => normalizePhone(n)).filter(Boolean)));
    if (recipients.length === 0) {
      return res.status(400).json({ error: 'to must contain at least one valid phone number' });
    }

    const results = await Promise.all(
      recipients.map(async (to) => {
        const sent = await sendWhatsAppMessageOrTemplate({
          to,
          message: parse.data.message,
          templateId: parse.data.templateId,
          templateData: parse.data.templateData,
        });

        if (sent) {
          try {
            await chatHistoryService.logChatMessage({
              db,
              threadId: to,
              role: 'Human',
               messageText:
                parse.data.message ||
                `[Template:${parse.data.templateId}] ${JSON.stringify(
                  parse.data.templateData || {}
                )}`,
              escalationId: null,
            });
          } catch (error) {
            console.error('Failed to log spontaneous outbound human chat message', error);
          }
        }

        return { to, sent };
      })
    );

    const sentCount = results.filter((r) => r.sent).length;
    const failedCount = results.length - sentCount;

    if (sentCount === 0) {
      return res.status(502).json({
        error: 'Failed to deliver message to all recipients',
        summary: { total: results.length, sentCount, failedCount },
        results,
      });
    }

    return res.status(200).json({
      success: true,
      summary: { total: results.length, sentCount, failedCount },
      results,
    });
  } catch (err) {
    console.error('Failed to send spontaneous human agent message', err);
    return res.status(500).json({ error: 'Failed to send spontaneous human agent message' });
  }
});


// body: { ticketId?: string, ticketStatus?: 'pending'|'completed', to?: string, message?: string }
app.post('/admin/escalation/:ticketId/status', async (req: Request, res: Response) => {
  try {
    const rawTicketId = req.params.ticketId;
    const ticketId = Array.isArray(rawTicketId) ? rawTicketId[0] : rawTicketId;

    const {
      ticketStatus,
      to,
      message,
      templateId,
      templateData,
      sendMessage = false,
    } = req.body || {};

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId is required' });
    }

    if (!ticketStatus || !['pending', 'completed'].includes(ticketStatus)) {
      return res.status(400).json({
        error: 'ticketStatus must be pending or completed',
      });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const result = await escalationService.notifyAndMaybeUpdate({
      db,
      ticketId,
      ticketStatus,
      to,
      message,

    sendMessage: sendMessage
        ? async (
            t: string,
            m: string
          ): Promise<boolean> => {
            try {
              return await sendWhatsAppMessageOrTemplate({
                to: t,

                message: templateId
                  ? undefined
                  : m,

                templateId,

                templateData,
              });
            } catch (err) {
              console.error(
                'Failed to send WhatsApp message:',
                err
              );

              return false;
            }
          }
        : undefined
    })

    return res.status(200).json({
      success: true,
      ticketId,
      status: ticketStatus,
      messageSent: sendMessage,
      ...result,
    });

  } catch (err) {
    console.error('Failed to update escalation', err);
    return res.status(500).json({ error: 'Failed to update escalation' });
  }
});

app.post('/admin/escalation/:ticketId/release', async (req: Request, res: Response) => {
  try {
    const rawTicketId = req.params.ticketId;
    const ticketId = Array.isArray(rawTicketId) ? rawTicketId[0] : rawTicketId;

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId is required' });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const ticket = await escalationService.getEscalationByTicketId(db, ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'The escalation with this ID is not found. Probably deleted' });
    }

    if (ticket.ticket_status !== 'pending') {
      return res.status(409).json({ error: 'Only pending escalations can be released back to the bot' });
    }

    const updated = await escalationService.setHumanAgentActive(db, ticketId, false);
    if (!updated) {
      return res.status(404).json({ error: 'The escalation with this ID is not found. Probably deleted' });
    }

    return res.status(200).json({
      success: true,
      ticketId,
      ticketStatus: updated.ticket_status,
      humanAgentActive: updated.human_agent_active,
    });
  } catch (e) {
    console.error('Failed to release human handoff', e);
    return res.status(500).json({ error: 'Failed to release human handoff' });
  }
});


app.get('/admin/escalation/:ticketId/messages', async (req: Request, res: Response) => {
  try {
    const rawTicketId = req.params.ticketId;
    const ticketId = Array.isArray(rawTicketId) ? rawTicketId[0] : rawTicketId;
    const directionRaw = req.query.direction;
    const limitRaw = req.query.limit;

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId is required' });
    }

    const direction = typeof directionRaw === 'string' ? directionRaw.trim().toLowerCase() : undefined;
    if (direction && !['inbound', 'outbound'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be one of: inbound, outbound' });
    }

    const limit = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : 50;
    if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const ticket = await escalationService.getEscalationByTicketId(db, ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'The escalation with this ID is not found. Probably deleted' });
    }

    const messages = await escalationService.getEscalationMessages(
      db,
      ticketId,
      direction as 'inbound' | 'outbound' | undefined,
      limit
    );

    return res.status(200).json({
      ticketId,
      count: messages.length,
      messages,
    });
  } catch (e) {
    console.error('Failed to fetch escalation messages', e);
    return res.status(500).json({ error: 'Failed to fetch escalation messages' });
  }
});


// delete /admin/escalation/:ticketId - could be added to remove escalations if needed, but not implemented here for safety
app.delete('/admin/escalation/:ticketId', async (req, res) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const { ticketId } = req.params;

    const result = await db.query(
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

    if (!result.rows.length) {
      return res.status(404).json({
        error: 'escalation_not_found_or_already_archived',
      });
    }

    return res.json({
      success: true,
      ticketId,
      archived: true,
    });

  } catch (e) {
    console.error('Archive escalation error:', e);
    return res.status(500).json({ error: 'Failed to archive escalation' });
  }
});

app.delete('/admin/escalation/:ticketId/purge', async (req: Request, res: Response) => {
  try {
    const rawTicketId = req.params.ticketId;
    const ticketId = Array.isArray(rawTicketId) ? rawTicketId[0] : rawTicketId;

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId is required' });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    // Optional safety: only allow deleting resolved tickets
    const existing = await db.query(
      'SELECT ticket_id, ticket_status FROM escalations WHERE ticket_id = $1',
      [ticketId]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ error: 'The escalation with this ID is not found. Probably deleted' });
    }

    const escalation = existing.rows[0];

    if (escalation.ticket_status !== 'completed') {
      return res.status(400).json({
        error: 'Only completed escalations can be deleted',
      });
    }

    // 🧨 Actual delete
    await db.query('DELETE FROM escalations WHERE ticket_id = $1', [ticketId]);

    return res.status(200).json({
      success: true,
      ticketId,
      deleted: true,
    });

  } catch (e) {
    console.error('Failed to delete escalation', e);
    return res.status(500).json({ error: 'Failed to delete escalation' });
  }
});

app.patch('/admin/escalation/:ticketId/unarchive', async (req, res) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const { ticketId } = req.params;

    const result = await db.query(
      `
      UPDATE escalations
      SET
        is_archived = FALSE,
        archived_at = NULL,
        updated_at = NOW()
      WHERE ticket_id = $1
        AND is_archived = TRUE
      RETURNING ticket_id
      `,
      [ticketId]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: 'escalation_not_found_or_not_archived',
      });
    }

    return res.json({
      success: true,
      ticketId,
      restored: true,
    });

  } catch (e) {
    console.error('Unarchive escalation error:', e);
    return res.status(500).json({ error: 'Failed to restore escalation' });
  }
});


app.get('/admin/escalations/archived', async (req, res) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const result = await db.query(`
      SELECT *
      FROM escalations
      WHERE is_archived = TRUE
      ORDER BY archived_at DESC
    `);

    return res.json({
      count: result.rows.length,
      escalations: result.rows,
    });

  } catch (e) {
    console.error('Get archived escalations error:', e);
    return res.status(500).json({ error: 'Failed to fetch archived escalations' });
  }
});






app.get('/admin/chat-history/messages', async (req: Request, res: Response) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : undefined;
    const role = typeof req.query.role === 'string' ? req.query.role.trim() as 'AI' | 'Human' | 'Customer' : undefined;
    const escalationId = typeof req.query.escalationId === 'string' ? req.query.escalationId.trim() : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from.trim() : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to.trim() : undefined;
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
    const offset = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0;

    if (role && !['AI', 'Human', 'Customer'].includes(role)) {
      return res.status(400).json({ error: 'role must be one of: AI, Human, Customer' });
    }

    if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 500' });
    }

    if (!Number.isFinite(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }

    const messages = await chatHistoryService.getChatHistory(db, {
      threadId,
      role,
      escalationId,
      from,
      to,
      limit,
      offset,
    });

    return res.status(200).json({
      filters: {
        threadId: threadId || null,
        role: role || null,
        escalationId: escalationId || null,
        from: from || null,
        to: to || null,
        limit,
        offset,
      },
      count: messages.length,
      messages,
    });
  } catch (e: any) {
    if (e.message === 'Invalid role') {
      return res.status(400).json({ error: 'role must be one of: AI, Human, Customer' });
    }
    console.error('Failed to fetch chat history messages', e);
    return res.status(500).json({ error: 'Failed to fetch chat history messages' });
  }
});

app.get('/admin/chat-history/threads', async (req: Request, res: Response) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : undefined;
    const role = typeof req.query.role === 'string' ? req.query.role.trim() as 'AI' | 'Human' | 'Customer' : undefined;
    const escalationId = typeof req.query.escalationId === 'string' ? req.query.escalationId.trim() : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from.trim() : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to.trim() : undefined;
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
    const offset = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0;

    if (role && !['AI', 'Human', 'Customer'].includes(role)) {
      return res.status(400).json({ error: 'role must be one of: AI, Human, Customer' });
    }

    if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 500' });
    }

    if (!Number.isFinite(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }

    const threads = await chatHistoryService.getChatHistoryThreads(db, {
      threadId,
      role,
      escalationId,
      from,
      to,
      limit,
      offset,
    });

    return res.status(200).json({
      filters: {
        threadId: threadId || null,
        role: role || null,
        escalationId: escalationId || null,
        from: from || null,
        to: to || null,
        limit,
        offset,
      },
      count: threads.length,
      threads,
    });
  } catch (e: any) {
    if (e.message === 'Invalid role') {
      return res.status(400).json({ error: 'role must be one of: AI, Human, Customer' });
    }
    console.error('Failed to fetch chat history threads', e);
    return res.status(500).json({ error: 'Failed to fetch chat history threads' });
  }
});




// ─── Admin - Meta Survey Routes ──────────────────────────────────────────────
app.post('/admin/meta-survey', async (req: Request, res: Response) => {
  try {
    const {
      name,
      description,
      surveyId,
      thankYouText,
      questions,
      autoPublish,
      dataEndpointUrl,
    } = req.body || {};

    if (!name || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        error: 'name and questions (non-empty array) are required',
      });
    }

    const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
    
    const endpointUrl =
      dataEndpointUrl || `${serverUrl}/webhook/meta-flow-data`;

    if (!endpointUrl.startsWith('https://')) {
      return res.status(400).json({
        error:
          'dataEndpointUrl must be a valid HTTPS URL. Set SERVER_URL or pass dataEndpointUrl.',
      });
    }

    // validate questions
    for (const q of questions) {
      if (!q.id || !q.text || !q.type) {
        return res.status(400).json({
          error: `Each question must have id, text, and type`,
        });
      }

      if (
        ['list', 'button'].includes(q.type) &&
        (!Array.isArray(q.options) || q.options.length === 0)
      ) {
        return res.status(400).json({
          error: `Question "${q.id}" must have options`,
        });
      }
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) throw new Error('DB not initialized');

    // 1. CREATE META FLOW ON META SIDE
    const flowJson = buildSurveyFlowJson(
      { id: surveyId, name, description, questions, thankYouText },
      endpointUrl
    );

    console.log("\n\nFINAL FLOW JSON:", JSON.stringify(flowJson, null, 2))

    const flowJsonBuffer = Buffer.from(JSON.stringify(flowJson, null, 2));

    const uniqueName = `${name} - ${
      surveyId || crypto.randomBytes(3).toString('hex')
    }`;

    const flowId = await createMetaFlow(uniqueName, ['SURVEY']);

    await uploadFlowJsonBuffer(flowId, flowJsonBuffer);

    // 2. SAVE TO MASTER SURVEYS TABLE (IMPORTANT FIX)
    const finalSurveyId =
      surveyId || `meta_${crypto.randomUUID().slice(0, 12)}`;

    await db.query(
      `
      INSERT INTO surveys (
        id,
        name,
        mode,
        description,
        questions_data,
        status,
        is_archived,
        archived_at
      )
      VALUES ($1, $2, 'meta', $3, $4, 'active', FALSE, NULL)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        questions_data = EXCLUDED.questions_data,
        updated_at = NOW()
      `,
      [
        finalSurveyId,
        name,
        description || null,
        JSON.stringify(questions),
      ]
    );

    // 3. SAVE META FLOW CONFIG
    await metaSurveyService.upsertMetaFlowSurvey(db, {
      flowId,
      flowName: name,
      surveyId: finalSurveyId,
      questionsData: questions,
      status: 'draft',
      dataEndpointUrl: endpointUrl,
    });

    // 4. OPTIONAL PUBLISH
    let publishResult: any = null;

    if (autoPublish) {
      try {
        publishResult = await publishFlow(flowId);
        await metaSurveyService.markFlowPublished(db, flowId);
      } catch (err) {
        console.error('Publish failed:', err);
      }
    }

    return res.status(201).json({
      success: true,
      surveyId: finalSurveyId,
      flowId,
      status: autoPublish ? 'published' : 'draft',
      dataEndpointUrl: endpointUrl,
      publishResult,
    });
  } catch (e: any) {
    console.error('POST /admin/meta-survey failed', e);

    return res.status(500).json({
      error: e.message || 'Failed to create meta survey',
    });
  }
});


app.get('/admin/meta-survey', async (req: Request, res: Response) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const query = req.query as Record<string, string | undefined>;
    const archived = query.archived === 'true';
    const { number, flowId, surveyId, from, to } = query;
    const limit = query.limit ? Math.min(Number.parseInt(query.limit, 10), 500) : 50;
    const offset = query.offset ? Number.parseInt(query.offset, 10) : 0;

    if (!Number.isFinite(limit) || limit < 1) {
      return res.status(400).json({ error: 'limit must be a positive integer (max 500)' });
    }

    if (!Number.isFinite(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }

    const [surveys, total] = await Promise.all([
      metaSurveyService.queryMetaFlowSurveys(db, { archived, number, flowId, surveyId, from, to, limit, offset }),
      metaSurveyService.countMetaFlowSurveys(db, { archived, number, flowId, surveyId, from, to }),
    ]);

    return res.status(200).json({
      count: surveys.length,
      total,
      limit,
      offset,
      filters: { archived, number: number || null, flowId: flowId || null, surveyId: surveyId || null, from: from || null, to: to || null },
      surveys,
    });
  } catch (e: any) {
    console.error('GET /admin/meta-survey failed', e);
    return res.status(500).json({ error: e.message || 'Failed to list meta surveys' });
  }
});


app.get('/admin/meta-survey/responses', async (req: Request, res: Response) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const query = req.query as Record<string, string>;

    const { flowId, customerPhone, surveyId, from, to } = query;
    const source = query.source || 'data_exchange';
    
    const limit = req.query.limit ? Math.min(Number.parseInt(req.query.limit as string, 10), 500) : 50;
    const offset = req.query.offset ? Number.parseInt(req.query.offset as string, 10) : 0;

    // 2. Database Queries
    const [rawResponses, total] = await Promise.all([
      metaSurveyService.queryMetaFlowResponses(db, { flowId, customerPhone, surveyId, source, from, to, limit, offset }),
      metaSurveyService.countMetaFlowResponses(db, { flowId, customerPhone, surveyId, source, from, to }),
    ]);

    // 3. Local Cache for Survey Definitions
    const surveyCache: Record<string, any[]> = {};

    // 4. Transformation Logic
    const finalResponses = await Promise.all(rawResponses.map(async (row: any) => {
      const fId = row.flow_id;

      console.log(`Processing response for flowId: ${row}`);
      if (fId && !surveyCache[fId]) {
        try {
          const surveyDef = await metaSurveyService.getMetaFlowSurveyByFlowId(db, fId);

          console.log(
            'questions_data:',
            surveyDef?.questions_data
          );

          console.log(
            'questions_data type:',
            typeof surveyDef?.questions_data
          );

          surveyCache[fId] = surveyDef?.questions_data || [];
        } catch {
          surveyCache[fId] = [];
        }
      }

      const questions = surveyCache[fId] || [];

       if (
        questions.length > 0 &&
        questions[0]?.id === 'QUESTIONS'
      ) {
        console.warn(
          `Flow ${fId} contains Flow JSON instead of survey questions`
        );
      }

      const mappedData = metaSurveyService.mapResponsesToQuestions(row.responses || {}, questions);

      // FIX 2: Destructure 'id' out of the row object to rename it explicitly
      const { id, responses: _oldResponses, ...otherData } = row;

      return {
        submission_id: id,
        ...otherData,
        responses: mappedData
      };
    }));

    // 5. Final Payload
    return res.status(200).json({
      count: finalResponses.length,
      total,
      limit,
      offset,
      responses: finalResponses
    });

  } catch (e: any) {
    console.error('GET /admin/meta-survey/responses failed', e);
    return res.status(500).json({ error: e.message || 'Failed to query responses' });
  }
});


app.get('/admin/meta-survey/:flowId', async (req: Request, res: Response) => {
  const flowId = getSingleRouteParam(req.params.flowId);
  try {
    if (!flowId) return res.status(400).json({ error: 'flowId is required' });
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });
    const local = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
    if (!local) return res.status(404).json({ error: 'Survey not found in local database' });
    let meta: any = null;
    try { meta = await getFlow(flowId); } catch (_) { /* non-fatal */ }
    return res.status(200).json({ local, meta });
  } catch (e: any) {
    console.error(`GET /admin/meta-survey/${flowId} failed`, e);
    return res.status(500).json({ error: e.message || 'Failed to get meta survey' });
  }
});

app.post('/admin/meta-survey/:flowId/publish', async (req: Request, res: Response) => {
  const flowId = getSingleRouteParam(req.params.flowId);

  try {
    if (!flowId) return res.status(400).json({ error: 'flowId is required' });
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const local = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
    if (!local) return res.status(404).json({ error: 'Survey not found in local database' });

    // ✅ STEP 1 — REBUILD FLOW JSON
    const endpointUrl = local.data_endpoint_url;
    const flowJson = buildSurveyFlowJson(
      {
        name: local.flow_name,
        description: '',
        questions: local.questions_data,
        thankYouText: '',
      },
      endpointUrl
    );

    console.log("RE-UPLOADING FLOW JSON:", JSON.stringify(flowJson, null, 2));

    //  STEP 2 — RE-UPLOAD (CRUCIAL FIX)
    await uploadFlowJsonBuffer(
      flowId,
      Buffer.from(JSON.stringify(flowJson))
    );

    
    const flowCheck = await getFlow(flowId);
    console.log("✅ VALIDATION AFTER UPLOAD:", flowCheck.validation_errors);

    if (flowCheck.validation_errors && flowCheck.validation_errors.length > 0) {
      return res.status(422).json({
        error: 'Flow JSON has validation errors — cannot publish',
        validation_errors: flowCheck.validation_errors,
      });
    }

    // ✅ STEP 3 — NOW publish
    const result = await publishFlow(flowId);

    await metaSurveyService.markFlowPublished(db, flowId);

    return res.status(200).json({ success: true, flowId, result });

  } catch (e: any) {
    console.error(`POST /admin/meta-survey/${flowId}/publish failed`, e);
    return res.status(500).json({ error: e.message || 'Publish failed' });
  }
});


app.post('/admin/meta-survey/:flowId/deprecate', async (req: Request, res: Response) => {
  const flowId = getSingleRouteParam(req.params.flowId);
  try {
    if (!flowId) return res.status(400).json({ error: 'flowId is required' });
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });
    const result = await deprecateFlow(flowId);
    await metaSurveyService.markFlowDeprecated(db, flowId);
    return res.status(200).json({ success: true, flowId, result });
  } catch (e: any) {
    console.error(`POST /admin/meta-survey/${flowId}/deprecate failed`, e);
    return res.status(500).json({ error: e.message || 'Deprecate failed' });
  }
});

app.delete('/admin/meta-survey/:flowId', async (req: Request, res: Response) => {
  const flowId = getSingleRouteParam(req.params.flowId);
  try {
    if (!flowId) return res.status(400).json({ error: 'flowId is required' });
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });
    const local = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
    if (!local) return res.status(404).json({ error: 'Survey not found in local database' });
    if (local.status === 'published') {
      return res.status(400).json({ error: 'Published flows cannot be hard-deleted. Use DELETE /admin/meta-survey/:flowId/delete-published instead.' });
    }
    await deleteFlow(flowId);


    await metaSurveyService.deleteMetaFlowSurveyRecord(db, flowId);

    


    return res.status(200).json({ success: true, flowId, deleted: true });
  } catch (e: any) {
    console.error(`DELETE /admin/meta-survey/${flowId} failed`, e);
    return res.status(500).json({ error: e.message || 'Delete failed' });
  }
});

app.delete('/admin/meta-survey/:flowId/delete-published/archived', async (req: Request, res: Response) => {
  const flowId = getSingleRouteParam(req.params.flowId);
  try {
    if (!flowId) return res.status(400).json({ error: 'flowId is required' });
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const local = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
    if (!local) return res.status(404).json({ error: 'Survey not found in local database' });

    if (!['published', 'deprecated'].includes(local.status)) {
      return res.status(400).json({ error: 'Only published/deprecated flows can use this endpoint. Use DELETE /admin/meta-survey/:flowId for draft flows.' });
    }

    if (local.status === 'published') {
      await deprecateFlow(flowId);
      await metaSurveyService.markFlowDeprecated(db, flowId);
    }

    await metaSurveyService.archiveMetaFlowSurvey(db, flowId);

    return res.status(200).json({ success: true, flowId, deletedSurvey: true, responsesDeleted: false });
  } catch (e: any) {
    console.error(`DELETE /admin/meta-survey/${flowId}/delete-published/archived failed`, e);
    return res.status(500).json({ error: e.message || 'Delete published flow failed' });
  }
});

app.delete('/admin/meta-survey/:flowId/delete-with-responses/purge', async (req: Request, res: Response) => {
  const flowId = getSingleRouteParam(req.params.flowId);
  try {
    if (!flowId) return res.status(400).json({ error: 'flowId is required' });
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const local = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
    if (!local) return res.status(404).json({ error: 'Survey not found in local database' });

    if (local.status === 'draft') {
      await deleteFlow(flowId);
    } else if (local.status === 'published') {
      await deprecateFlow(flowId);
      await metaSurveyService.markFlowDeprecated(db, flowId);
    }

    const totalResponses = await metaSurveyService.countMetaFlowResponses(db, { flowId });
    await metaSurveyService.deleteMetaFlowResponsesByFlowId(db, flowId);
    await metaSurveyService.deleteMetaFlowSurveyRecord(db, flowId);

    return res.status(200).json({
      success: true,
      flowId,
      deletedSurvey: true,
      responsesDeleted: totalResponses,
    });
  } catch (e: any) {
    console.error(`DELETE /admin/meta-survey/${flowId}/delete-with-responses failed`, e);
    return res.status(500).json({ error: e.message || 'Delete flow and responses failed' });
  }
});


app.post('/admin/meta-survey/send', async (req: Request, res: Response) => {
  try {
    const { to, flowId, flowToken, cta, headerText, bodyText, footerText, phoneNumberId } = req.body || {};
    if (!to || !flowId) {
      return res.status(400).json({ error: 'to and flowId are required' });
    }

    const recipients = (Array.isArray(to) ? to : [to])
      .map((phone: any) => normalizePhone(String(phone || '')))
      .filter(Boolean);

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'at least one valid recipient is required in to' });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const localFlow = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
    const flowMode = localFlow?.status === 'published' ? 'published' : 'draft';

    const customFlowTokenProvided = typeof flowToken === 'string' && flowToken.trim().length > 0;

    let baseFlowToken = customFlowTokenProvided
      ? flowToken.trim()
      : `flow-${Date.now()}-${randomUUID().slice(0, 8)}`;

    if (baseFlowToken.length > 120) {
      return res.status(400).json({ error: 'flowToken must be 120 characters or fewer' });
    }

    const buildTokens = (baseToken: string) => (
      recipients.map((_, i) => (recipients.length === 1 ? baseToken : `${baseToken}-${i + 1}`))
    );

    let candidateTokens = buildTokens(baseFlowToken);

    if (customFlowTokenProvided) {
      const conflicts = await Promise.all(
        candidateTokens.map((token) => metaSurveyService.isMetaFlowTokenUsed(db, token))
      );
      if (conflicts.some(Boolean)) {
        return res.status(409).json({
          error: 'flowToken already exists. Provide a unique flowToken or omit it to auto-generate one.',
          baseFlowToken,
        });
      }
    } else {
      let guard = 0;
      while (guard < 5) {
        const conflicts = await Promise.all(
          candidateTokens.map((token) => metaSurveyService.isMetaFlowTokenUsed(db, token))
        );
        if (!conflicts.some(Boolean)) break;
        baseFlowToken = `flow-${Date.now()}-${randomUUID().slice(0, 8)}`;
        candidateTokens = buildTokens(baseFlowToken);
        guard += 1;
      }
    }

    const settled = await Promise.allSettled(recipients.map((phone, i) => {
      const tokenForRecipient = candidateTokens[i];

      return sendFlowMessage({
        to: phone,
        flowId,
        flowToken: tokenForRecipient,
        flowMode,
        cta: cta || 'Take Survey',
        headerText,
        bodyText,
        footerText,
        phoneNumberId,
      }).then((result) => ({ to: phone, flowToken: tokenForRecipient, result }));
    }));

    const successfulDispatches = settled
      .map((entry, idx) => ({ entry, idx }))
      .filter(({ entry }) => entry.status === 'fulfilled');

    if (successfulDispatches.length > 0) {
      const localFlow = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
      await Promise.all(
        successfulDispatches.map(async ({ idx }) => {
          const phone = recipients[idx];
          const tokenForRecipient = candidateTokens[idx];
          await metaSurveyService.upsertMetaFlowTokenMap(db, {
            flowToken: tokenForRecipient,
            flowId,
            surveyId: localFlow?.survey_id || undefined,
            customerPhone: phone,
          });
        })
      );
    }

    const results = settled.map((entry, idx) => {
      const phone = recipients[idx];
      const tokenForRecipient = candidateTokens[idx];
      if (entry.status === 'fulfilled') {
        return { success: true, to: phone, flowToken: tokenForRecipient, result: entry.value.result };
      }
      const message = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
      return { success: false, to: phone, flowToken: tokenForRecipient, error: message };
    });

    const sent = results.filter((r) => r.success).length;
    const failed = results.length - sent;

    if (sent === 0) {
      return res.status(500).json({
        success: false,
        error: 'Failed to send flow message to all recipients',
        flowId,
        sent,
        failed,
        results,
      });
    }

    return res.status(200).json({
      success: true,
      partial: failed > 0,
      flowId,
      baseFlowToken,
      sent,
      failed,
      results,
    });
  } catch (e: any) {
    console.error('POST /admin/meta-survey/send failed', e);
    return res.status(500).json({ error: e.message || 'Failed to send flow message' });
  }
});



app.post('/webhook/meta-flow-data', async (req: Request, res: Response) => {
  try {
    const {
      encrypted_flow_data,
      encrypted_aes_key,
      initial_vector,
    } = req.body;

    // ─────────────────────────────────────────────
    //  DECRYPT AES KEY (RSA)
    // ─────────────────────────────────────────────
    const privateKey = process.env.WHATSAPP_PRIVATE_KEY!
      .replace(/\\n/g, '\n')
      .trim();

    const aesKey = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(encrypted_aes_key, 'base64')
    );

    // ─────────────────────────────────────────────
    // DECRYPT REQUEST PAYLOAD (AES-128-GCM)
    // ─────────────────────────────────────────────
    const iv = Buffer.from(initial_vector, 'base64');
    const encryptedBuffer = Buffer.from(encrypted_flow_data, 'base64');

    const tag = encryptedBuffer.slice(encryptedBuffer.length - 16);
    const ciphertext = encryptedBuffer.slice(0, encryptedBuffer.length - 16);

    const decipher = crypto.createDecipheriv(
      'aes-128-gcm',
      aesKey,
      iv
    );
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(ciphertext, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    const payload = JSON.parse(decrypted);

    // console.log('🎯 ACTION:', payload.action);

    // console.log(
    //   'FULL FLOW PAYLOAD:',
    //   JSON.stringify(payload, null, 2)
    // );

    const flippedIv = Buffer.from(iv.map((byte) => ~byte));

    const encryptResponse = (
      responsePayload: Record<string, any>,
      useIv: Buffer = flippedIv
    ) => {
      const cipher = crypto.createCipheriv(
        'aes-128-gcm',
        aesKey,
        useIv
      );

      let encryptedRes = cipher.update(
        JSON.stringify(responsePayload),
        'utf8'
      );
      encryptedRes = Buffer.concat([encryptedRes, cipher.final()]);

      const resTag = cipher.getAuthTag();

      return Buffer.concat([
        encryptedRes,
        resTag,
      ]).toString('base64');
    };

    // ─────────────────────────────────────────────
    // 🔥 3️⃣ META HEALTH CHECK (PING / INIT)
    // ─────────────────────────────────────────────
    if (payload.action === 'ping') {
      const responsePayload = {
        data: {
          status: 'active',
        },
      };

      return res.status(200).type('text/plain').send(encryptResponse(responsePayload));
    }

    if (payload.action === 'INIT' || payload.action === 'BACK') {
      // For dynamic-visibility flows we must return the initial data block
      // (all show_xxx = false) so conditional questions start hidden.
      let initData: Record<string, boolean> = {};
      try {
        const storage = mastra.getStorage() as any;
        const db = storage?.db;
        if (db) {
          const payloadFlowId = payload?.flow_id || payload?.data?.flow_id || payload?.context?.flow_id;
          const flowToken = payload?.flow_token || payload?.data?.flow_token || payload?.context?.flow_token;
          let flowId = payloadFlowId ? String(payloadFlowId) : 'unknown';
          if (flowId === 'unknown' && flowToken) {
            try {
              const tokenMap = await metaSurveyService.getMetaFlowTokenMapByToken(db, String(flowToken));
              if (tokenMap?.flow_id) flowId = tokenMap.flow_id;
            } catch {}
          }
          if (flowId !== 'unknown') {
            const localFlow = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
            const questions: any[] = Array.isArray(localFlow?.questions_data) ? localFlow.questions_data : [];
            for (const q of questions) {
              if (q.showIf) initData[`show_${q.id}`] = false;
            }
          }
        }
      } catch {}

      return res.status(200).type('text/plain').send(encryptResponse({
        version: payload.version || '3.0',
        screen: payload.screen || 'QUESTIONS',
        data: initData,
      }));
    }

    if (payload.action === 'data_exchange') {
      try {
        const storage = mastra.getStorage() as any;
        const db = storage?.db;

        if (db) {
          const flowToken = payload?.flow_token || payload?.data?.flow_token || payload?.context?.flow_token;
          const payloadFlowId = payload?.flow_id || payload?.data?.flow_id || payload?.context?.flow_id;
          const responseData: Record<string, any> = (payload?.data && typeof payload.data === 'object') ? payload.data : {};

          if (flowToken) {
            let flowId = payloadFlowId ? String(payloadFlowId) : 'unknown';
            let surveyId: string | undefined;
            let customerPhone: string | undefined;
            let questionsData: any[] = [];

            // Look up token map to get phone + flow metadata
            try {
              const tokenMap = await metaSurveyService.getMetaFlowTokenMapByToken(db, String(flowToken));
              if (tokenMap) {
                customerPhone = tokenMap.customer_phone;
                surveyId = tokenMap.survey_id || undefined;
                if (flowId === 'unknown' && tokenMap.flow_id) {
                  flowId = tokenMap.flow_id;
                }
              }
            } catch (lookupErr) {
              console.error('Token lookup failed:', lookupErr);
            }

            // Get questions data for visibility computation
            if (flowId !== 'unknown') {
              try {
                const localFlow = await metaSurveyService.getMetaFlowSurveyByFlowId(db, String(flowId));
                surveyId = surveyId || localFlow?.survey_id || undefined;
                questionsData = Array.isArray(localFlow?.questions_data) ? localFlow.questions_data : [];
              } catch {}
            }

            // Strip internal flags before saving answers
            const { __submit__, ...answerFields } = responseData as any;

            // Merge with previously accumulated answers
            const existing = await metaSurveyService.getAccumulatedFlowResponses(db, String(flowToken));
            const allAnswers = { ...existing, ...answerFields };

            // Persist accumulated partial answers
            await metaSurveyService.upsertAccumulatedFlowResponses(db, {
              flowToken: String(flowToken),
              flowId: String(flowId),
              surveyId,
              customerPhone,
              answers: allAnswers,
            });

            // ── FINAL SUBMIT ────────────────────────────────────────────────
            if (String(__submit__) === '1') {
              await metaSurveyService.saveMetaFlowResponse(db, {
                flowId: String(flowId),
                flowToken: String(flowToken),
                customerPhone,
                surveyId,
                responses: allAnswers,
                source: 'data_exchange',
              });
              console.log(`✅ Final response saved for phone: ${customerPhone}`);

              return res.status(200).type('text/plain').send(encryptResponse({
                version: payload.version || '3.0',
                screen: 'COMPLETE',
                data: {},
              }));
            }

            // ── INTERMEDIATE UPDATE (parent question selection changed) ─────
            // Recompute which conditional questions should be visible
            const visibilityData = computeVisibilityData(questionsData, allAnswers);
            console.log('🔄 Visibility update:', visibilityData, 'answers:', allAnswers);

            return res.status(200).type('text/plain').send(encryptResponse({
              version: payload.version || '3.0',
              screen: 'QUESTIONS',
              data: visibilityData,
            }));
          }
        }
      } catch (saveErr) {
        console.error('❌ Failed to save data_exchange response', saveErr);
      }

      // Fallback
      return res.status(200).type('text/plain').send(encryptResponse({
        version: payload.version || '3.0',
        screen: 'COMPLETE',
        data: {},
      }));
    }

    // Non-data_exchange action fallback
    return res.status(200).type('text/plain').send(encryptResponse({
      version: payload.version || '3.0',
      screen: 'COMPLETE',
      data: {},
    }));

  } catch (err: any) {
    console.error('❌ META FLOW FAILURE', err);
    return res.status(500).json({ error: err.message });
  }
});



app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const statusCode = Number.isInteger(err?.status) ? err.status : 500;
  const safeStatus = statusCode >= 400 && statusCode < 600 ? statusCode : 500;

  if (safeStatus >= 500) {
    console.error('[Unhandled Error]', err);
  }

  return res.status(safeStatus).json({
    success: false,
    error: safeStatus >= 500 ? 'Internal server error' : (err?.message || 'Request failed'),
  });
});




let isReady = false;

app.get('/health', (_req, res) => {
  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'starting',
  });
});




async function initialize() {
  try {
    await initDatabase();
    await createKbDocsTable();
    await initVectorIndex();

    isReady = true;
    console.log("Application is ready.");
  } catch (err) {
    console.error("Initialization failed:", err);
    process.exit(1);
  }
}

async function startServer() {
  try {
    const httpServer = createServer(app);
    setupRealtimeHub(httpServer);

    const server = new MastraServer({ app: app as any, mastra: mastra as any });
    await server.init();

    httpServer.listen(PORT, () => {
      console.log(`Server listening on ${PORT}`);
    });

    // Don't wait for initialization before listening
    initialize();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

startServer();
