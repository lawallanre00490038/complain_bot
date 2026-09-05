import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { sendWhatsAppSurvey } from '../../whatsapp-client.js'

type Option = {
  id: string;
  title: string;
}


export const sendWhatsAppSurveyTool = createTool({
  id: 'send-whatsapp-survey',
  description: 'Sends an interactive survey question with up to 3 buttons to a customer via WhatsApp.',
  inputSchema: z.object({
    to: z.string().describe("The recipient's WhatsApp number (e.g. 2348163649273)."),
    surveyId: z.string().describe('A unique ID for the survey.'),
    question: z.string().describe('The survey question text (can include emoji).'),
    // options: z.array(z.string()).describe('An array of 2-3 answer options (each max 20 chars).'),
    options: z.array(
      z.object({
        id: z.string(),
        title: z.string()
      })
    ).describe('An array of 2-3 answer options, each with an id and title (title max 20 chars).'),
    headerText: z.string().optional().describe('Optional header text (max 60 chars).'),
    footerText: z.string().optional().describe('Optional footer text (max 60 chars).'),
  }),
  outputSchema: z.object({
    success: z.boolean().describe('Whether the survey was sent successfully.'),
  }),
  execute: async ({ to, question, options, headerText, footerText }) => {
    const success = await sendWhatsAppSurvey({ to, question, options, headerText, footerText })
    return { success }
  },
})
