/**
 * sendAgentReply — smart reply sender for the chat agent.
 *
 * The engagement agent appends a sentinel tag to its response whenever it
 * wants to render a tappable WhatsApp select list:
 *
 *   <options>[{"id":"1","title":"Accounts & Products"}, ...]</options>
 *
 * This function strips the tag from the displayed text and sends a single
 * interactive list message (body + Select button joined). Plain replies
 * with no tag are sent as normal text messages.
 */

import { normalizePhone } from './format_phone.js';
import { sendWhatsAppMessage, sendWhatsAppList } from '../whatsapp-client.js';

export interface AgentReplyOption {
  id: string;
  title: string;
}

const OPTIONS_RE = /<options>([\s\S]*?)<\/options>/i;

/**
 * Extracts the <options>...</options> sentinel from the agent's raw text.
 * Returns the clean display text and the parsed options array (or undefined).
 */
export function extractOptions(raw: string): {
  text: string;
  options: AgentReplyOption[] | undefined;
} {
  const match = OPTIONS_RE.exec(raw);
  console.log('[sendAgentReply] raw text length:', raw.length, '| <options> tag found:', !!match);
  if (!match) return { text: raw.trim(), options: undefined };

  const cleanText = raw.replace(OPTIONS_RE, '').trim();

  let options: AgentReplyOption[] | undefined;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (Array.isArray(parsed) && parsed.length >= 2) {
      options = parsed
        .filter((o: any) => o?.id != null && o?.title)
        .slice(0, 10)
        .map((o: any) => ({ id: String(o.id), title: String(o.title) }));
    }
  } catch (e) {
    console.warn('⚠️ Failed to parse <options> sentinel JSON:', e);
  }

  return { text: cleanText, options: options?.length ? options : undefined };
}

/**
 * Sends the agent reply.
 * If the raw text contains an <options> sentinel with 2+ items, sends a
 * single interactive list message (body + Select button in one bubble).
 * Otherwise sends a plain text message.
 */
export async function sendAgentReply(phone: string, rawText: string, phoneNumberId?: string): Promise<void> {
  const to = normalizePhone(String(phone));
  const { text, options } = extractOptions(rawText);

  //THE FIX: Convert AI markdown **bold** to WhatsApp *bold*
  const sanitizedText = text.replace(/\*\*/g, '*');

  if (options && options.length >= 2) {
    // Trim to WhatsApp's 1024-char body limit using the sanitized text
    const bodyText = sanitizedText.length <= 1024 ? sanitizedText : sanitizedText.substring(0, 1021) + '...';

    const rows = options.map(opt => ({
      id: opt.id,
      title: opt.title.substring(0, 24),
      description: opt.title.length > 24 ? opt.title.substring(0, 72) : undefined,
    }));

    const sent = await sendWhatsAppList({
      to,
      bodyText, // Uses the sanitized text here!
      buttonText: 'Select',
      sections: [{ title: 'Options', rows }],
      phoneNumberId,
    }).catch(err => {
      console.warn('⚠️ Interactive list send failed (non-fatal):', err);
      return false;
    });

    // Fallback to plain text if the interactive list call fails
    if (!sent) {
      await sendWhatsAppMessage({ to, message: sanitizedText, phoneNumberId });
    }
    return;
  }

  // No options — plain text
  await sendWhatsAppMessage({ to, message: sanitizedText, phoneNumberId });
}
