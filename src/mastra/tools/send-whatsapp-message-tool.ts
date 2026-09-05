import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { sendWhatsAppMessage } from '../../whatsapp-client.js'

export const sendWhatsAppMessageTool = createTool({
  id: 'send-whatsapp-message',
  description: 'Sends a text message to a user via WhatsApp.',
  inputSchema: z.object({
    to: z.string().describe('The recipient\'s WhatsApp number.'),
    message: z.string().describe('The text message to send.'),
  }),
  outputSchema: z.object({
    success: z.boolean().describe('Whether the message was sent successfully.'),
  }),
  execute: async ({ to, message }) => {
    const success = await sendWhatsAppMessage({ to, message })
    return { success }
  },
})
