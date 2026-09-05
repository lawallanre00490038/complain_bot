import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { sendWhatsAppSurvey } from '../../whatsapp-client.js';

export const sendFeedbackSurveyTool = createTool({
  id: 'send-feedback-survey',
  description: 'Send a short automated feedback survey after a customer conversation.',
  inputSchema: z.object({
    customerPhone: z.string().describe('Recipient WhatsApp number.'),
    headerText: z.string().optional(),
    footerText: z.string().optional(),
  }),
  outputSchema: z.object({ success: z.boolean() }),
  execute: async (input, context) => {
    const handoffPhone =
      context?.agent?.threadId?.replace('thread_', '') ||
      input.customerPhone;

    const mastraInstance = (context as any)?.mastra ?? (context as any)?.agent?.mastra;
    const db = mastraInstance?.getStorage?.()?.db;
    if (!db) {
      throw new Error('DB not available for feedback survey tool');
    }

    const surveyId = 'feedback-survey';

    const workflow = mastraInstance?.getWorkflow?.('surveyWorkflow');
    if (!workflow) {
      throw new Error('surveyWorkflow not available');
    }

    // wait for like 2 seconds to ensure the workflow is ready
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const run = await workflow.createRun();
    const result = await run.start({
      inputData: {
        to: handoffPhone,
        surveyId,
        topic: 'Customer Feedback',
        mode: 'manual',
      },
    });

    const success = Boolean((result as any)?.result?.success ?? true);

    return { success };
  },
});
