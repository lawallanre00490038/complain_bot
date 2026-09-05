import "dotenv/config";

import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { normalizePhone } from "../../utils/format_phone.js";
import { sendSurveyIntro } from "../../utils/survey.sender.js";
import { mastra } from '../index.js';


async function loadManualSurveyQuestions(surveyId?: string, mode?:  'manual' | 'ai') {
  if (!surveyId) return null;

  const storage = mastra.getStorage() as any;
  const db = storage?.db;

  if (!db) throw new Error("DB not initialized");

  const result = await db.query(
    `
    SELECT questions_data
    FROM surveys
    WHERE id = $1
    AND mode = $2
    AND is_archived = FALSE
    `,
    [surveyId, mode || 'manual']
  );

  // if survey is archived

  // --- THE FIX IS HERE ---
  // Access result.rows instead of result directly
  if (!result?.rows || result.rows.length === 0) {
    console.log(`❌ No survey found for ID: ${surveyId}`);
    return null;
  }

  console.log(`\n\n✅ Loaded survey template for ID: ${surveyId}`, result.rows[0]);

  const questions = result.rows[0].questions_data;
  // -----------------------

  if (!Array.isArray(questions)) return null;

  return questions.map((q: any) => ({
    id: q.id,
    question: q.text,
    options: q.options || [],
    type: q.type,
    text: q.text,
    sectionTitle: q.sectionTitle,
    placeholder: q.placeholder,
    showIf: q.showIf,
    allowMultiple: q.allowMultiple,
  }));
}

const generateSurveyContent = createStep({
  id: 'generate-survey-content',
  description: 'Generate one or more survey questions from a topic using the Survey Agent',
  inputSchema: z.object({ 
    topic: z.string(),
    surveyId: z.string().optional(),
    context: z.string().optional(),
    mode: z.enum(['ai', 'manual']).optional(),
    expiryHours: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    questions: z.array(z.object({
      id: z.string().optional(),
      question: z.string(),
      options: z.array(z.string()),
      type: z.enum(['button', 'list', 'text', 'multi']).optional(),
      text: z.string().optional(),
      sectionTitle: z.string().optional(),
      placeholder: z.string().optional(),
      showIf: z.object({ dependsOn: z.string(), equals: z.string() }).optional(),
      allowMultiple: z.boolean().optional(),
    })),
  }),
  execute: async ({ inputData, mastra }) => {
    // Route by mode: manual = use local template, ai = generate
    if (inputData.mode === 'manual') {
      const manualQuestions = await loadManualSurveyQuestions(inputData.surveyId, inputData.mode);
      if (manualQuestions) {
        console.log(`Manual Questions is ${JSON.stringify(manualQuestions)}`);
        console.log(`Using manual survey template for ${inputData.surveyId}`);
        return { questions: manualQuestions }
      } else {
        throw new Error(`survey does not exist: ${inputData.surveyId}`)
      }
    }

    const agent = mastra?.getAgent('surveyAgent')
    if (!agent) throw new Error('Survey agent not found')

    // Compose prompt with context if provided
    let prompt = `Generate a detailed multi-question survey about: ${inputData.topic}`;
    if (inputData.context) {
      prompt += `\nContext: ${inputData.context}`;
    }

    // Try multi-question format first
    let response: any;
    try {
      response = await agent.generate(
        [{ role: 'user', content: prompt }],
        {
          structuredOutput: {
            schema: z.object({
              questions: z.array(z.object({
                id: z.string(),
                question: z.string(),
                options: z.array(z.string()),
                type: z.enum(['button', 'list', 'multi', 'text']).optional(),
                showIf: z.object({ dependsOn: z.string(), equals: z.string() }).optional(),
                allowMultiple: z.boolean().optional(),
              })).optional(),
              id: z.string(),
              question: z.string().optional(),
              options: z.array(z.string()).optional(),
              type: z.enum(['button', 'list', 'multi', 'text']).optional(),
              showIf: z.object({ dependsOn: z.string(), equals: z.string() }).optional(),
              allowMultiple: z.boolean().optional(),
            }),
          },
          memory: {
            thread: `survey_thread_${Date.now()}`,
            resource: `survey_${inputData.surveyId || 'default'}`,
          },
        }
      );
    } catch (error) {
      if (inputData.surveyId) {
        const manualQuestions = await loadManualSurveyQuestions(inputData.surveyId, 'manual');
        if (manualQuestions) {
          console.warn(`AI survey generation failed for ${inputData.surveyId}; falling back to local template.`, error);
          return { questions: manualQuestions };
        }
      }

      throw error;
    }

    if (!response.object) throw new Error('Failed to generate survey content')

    // Normalize: handle both single-question and multi-question responses
    const obj = response.object
    if (obj.questions && obj.questions.length > 0) {

      obj.questions = obj.questions.map((q: any, index: number) => {
        // 1. Force standard IDs to ensure perfect sequence
        q.id = `q${index + 1}`; 

        // 2. Eradicate impossible self-dependencies or q1 dependencies
        if (q.id === 'q1' || (q.showIf && q.showIf.dependsOn === q.id)) {
          delete q.showIf;
        }

        // 3. Strictly enforce allowMultiple rules
        if (q.type === 'multi') {
          q.allowMultiple = true;
        } else {
          delete q.allowMultiple; 
        }

        return q;
      });

      const surveyId =
        inputData.surveyId || `ai-survey-${Date.now()}`;

      const storage = mastra.getStorage() as any;
      const db = storage?.db;

      await db.query(
        `
        INSERT INTO surveys (
          id,
          name,
          mode,
          questions_data
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO NOTHING
        `,
        [
          surveyId,
          inputData.topic,
          'ai',
          JSON.stringify(obj.questions),
        ]
      );

      return {
        surveyId,
        questions: obj.questions,
      };

    } else if (obj.question && obj.options) {
      console.log(`\n\n✅ Generated single-question survey: ${obj.question} with options: ${obj.options}`);
      return { questions: [{ question: obj.question, options: obj.options }] }
    }

    throw new Error('Invalid survey content structure from agent')
  },
})

// ─── Step 2: Send all survey questions sequentially via WhatsApp ─────────────
const sendSurveyQuestions = createStep({
  id: 'send-survey-questions',
  description: 'Send each survey question as a separate interactive WhatsApp message',
  inputSchema: z.object({
    to: z.string(),
    surveyId: z.string(),
    surveyIntroTemplateId: z.string().optional(),
    expiryHours: z.number().int().positive().optional(),
    questions: z.array(z.object({
      id: z.string().optional(),
      question: z.string(),
      options: z.array(z.string()),
      type: z.enum(['button', 'list', 'text', 'multi']).optional(),
      text: z.string().optional(),
      sectionTitle: z.string().optional(),
      placeholder: z.string().optional(),
      showIf: z.object({ dependsOn: z.string(), equals: z.string() }).optional(),
      allowMultiple: z.boolean().optional(),
    })),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    questionsSent: z.number(),
    surveySessionId: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const { to, surveyId, questions, surveyIntroTemplateId } = inputData
    const surveySessionId = `${surveyId}_${Date.now()}`
    const expiresAt = typeof inputData.expiryHours === 'number'
      ? new Date(Date.now() + inputData.expiryHours * 60 * 60 * 1000).toISOString()
      : null;

    // Store survey session in Postgres for response tracking
    const storage = mastra?.getStorage()
    if (storage) {
      try {
        const workflowsStore = await storage.getStore('workflows')
        if (workflowsStore) {
          // Use the underlying db client for custom tables
          const pgStore = storage as any
          if (pgStore.db) {
            const result = await pgStore.db.any(
              `INSERT INTO survey_sessions (
                id,
                survey_id,
                customer_phone,
                current_question,
                total_questions,
                questions_data,
                status,
                expires_at,
                created_at,
                updated_at
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
              [
                surveySessionId,
                surveyId,
                normalizePhone(to),
                -1,
                questions.length,
                JSON.stringify(questions),
                'active',
                expiresAt,
                new Date().toISOString(),
                new Date().toISOString(),
              ]
            )
            console.log("\n\nDB INSERT RESULT:", result);
          } 
        }
      } catch (err) {
        // Table might not exist yet — we'll handle this gracefully
        console.error('❌ FAILED TO SAVE SESSION:', err)
        throw err
      }
    }


    const sent = await sendSurveyIntro({
      to,
      phoneNumberId: undefined,
      surveyIntroTemplateId,
    })


    const result =  {
      success: sent,
      questionsSent: sent ? 1 : 0,
      surveySessionId,
    };

    return result
  },
})

// ─── Workflow: Generate → Send ───────────────────────────────────────────────
export const surveyWorkflow = createWorkflow({
  id: 'survey-workflow',
  inputSchema: z.object({
    to: z.string(),
    surveyId: z.string(),
    topic: z.string(),
    context: z.string().optional(),
    surveyIntroTemplateId: z.string().optional(),
    mode: z.enum(['ai', 'manual']).optional(),
    expiryHours: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    questionsSent: z.number(),
    surveySessionId: z.string(),
  }),
} as const)
  .map(async ({ inputData }) => inputData)
  .then(generateSurveyContent)
  .map(async ({ inputData, getInitData }): Promise<{
    to: string;
    surveyId: string;
    surveyIntroTemplateId?: string;
    questions: Array<{
      id?: string;
      question: string;
      options: string[];
      type?: 'button' | 'list' | 'text' | 'multi';
      text?: string;
      sectionTitle?: string;
      placeholder?: string;
      showIf?: { dependsOn: string; equals: string };
      allowMultiple?: boolean;
    }>;
  }> => {
    const initData = getInitData<typeof surveyWorkflow>()
    return {
      to: initData.to,
      surveyId: initData.surveyId,
      surveyIntroTemplateId: initData.surveyIntroTemplateId,
      questions: inputData.questions,
    }
  })
  .then(sendSurveyQuestions)

surveyWorkflow.commit()
