import { sendWhatsAppTemplate } from '../whatsapp-client.js';


export async function sendMetaTemplate({
  to,
  templateId,
  topic,
}: {
  to: string;
  templateId: string;
  topic?: string;
}) {


  return sendWhatsAppTemplate({
    to,
    templateId: templateId,

    templateData: {
      body: [
        topic || 'Survey Feedback',
      ],
    },
  });
}
