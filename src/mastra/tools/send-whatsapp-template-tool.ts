import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { sendWhatsAppTemplate } from '../../whatsapp-client.js'




export const sendWhatsAppTemplateTool = createTool({
  id: 'send-whatsapp-template',
  description:
    'Sends a pre-approved WhatsApp template message to a customer. Use this for proactive outreach outside the 24-hour customer service window.',
  inputSchema: z.object({
    to: z.string().describe("The recipient's WhatsApp number."),

    templateId: z
      .string()
      .describe(
        'The name of the approved WhatsApp template (e.g. survey_invitation_scale).'
      ),

    templateData: z
      .object({
        header: z.array(z.string()).optional(),
        body: z.array(z.string()).optional(),
        buttons: z.array(z.string()).optional(),
      })
      .optional()
      .describe(
        'Template placeholder values grouped by component type.'
      ),
  }),
  outputSchema: z.object({
    success: z
      .boolean()
      .describe(
        'Whether the template message was sent successfully.'
      ),
  }),

  execute: async ({
    to,
    templateId,
    templateData,
  }) => {
    const success = await sendWhatsAppTemplate({
      to,
      templateId,
      templateData,
    });

    return { success };
  },
});
