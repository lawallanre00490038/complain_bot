// ─── WhatsApp Business API Client ────────────────────────────────────────────
// Supports: text messages, interactive button surveys, template messages,
// and list messages for multi-option surveys.
import "dotenv/config";
import { SendSurveyParams } from "./flow.types.js";
import { normalizePhone } from './utils/format_phone.js';

type WhatsAppRequestContext = {
  phoneNumberId?: string;
};

const isWhatsAppMessageId = (messageId: string | undefined): boolean => {
  return typeof messageId === 'string' && messageId.startsWith('wamid.');
};

const getConfig = (context?: WhatsAppRequestContext) => {
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';
  const phoneNumberId = context?.phoneNumberId || process.env.WHATSAPP_BUSINESS_PHONE_NUMBER_ID;
  
  console.log('getConfig called with context:', context);

  
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    throw new Error('Missing WHATSAPP_BUSINESS_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN');
  }
  return {
    url: `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  };
};

async function post(payload: Record<string, unknown>, context?: WhatsAppRequestContext): Promise<{ ok: boolean; data: any }> {
  const { url, headers } = getConfig(context);
  // Log request payload (safe) to help debug delivery problems
  try {
    console.log('WhatsApp API request URL:', url);
    // Do not print the full Authorization header; just indicate presence
    console.log('WhatsApp API request headers: { Content-Type:', headers['Content-Type'], ', Authorization: <hidden> }');
    console.log('WhatsApp API request payload:', JSON.stringify(payload, null, 2));
  } catch (e) {
    // ignore logging errors
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    let data: any = null;
    try {
      data = await res.json();
    } catch (e) {
      data = await res.text().catch(() => null);
    }

    console.log('WhatsApp API response status:', res.status, res.statusText);
    console.log('WhatsApp API response body:', JSON.stringify(data, null, 2));

    // Additional sanity checks: successful HTTP but missing messages
    if (res.ok) {
      if (!data) {
        console.warn('⚠️ WhatsApp API returned empty body despite 2xx status');
      } else if (!data.messages && !data.error) {
        console.warn('⚠️ WhatsApp API 2xx response without messages or error field:', Object.keys(data));
      } else if (data.messages) {
        // Log message_status — Meta can return 200 but status="failed" silently
        data.messages.forEach((m: any) => {
          if (m.message_status && m.message_status !== 'accepted') {
            console.warn(`⚠️ Message ${m.id} status: ${m.message_status} — may not be delivered`);
          } else {
            console.log(`📨 Message ${m.id} status: ${m.message_status ?? 'accepted'}`);
          }
        });
      }
      // Surface any error embedded in a 2xx response (Meta sometimes does this)
      if (data?.error) {
        console.error('❌ Meta returned error inside 2xx:', JSON.stringify(data.error, null, 2));
      }
    }

    if (!res.ok) {
      console.error('❌ WhatsApp API error:', JSON.stringify(data, null, 2));
    }

    return { ok: res.ok, data };
  } catch (err) {
    console.error('❌ WhatsApp API request failed:', err);
    return { ok: false, data: err };
  }
}

// ─── 1. Plain text message ───────────────────────────────────────────────────

export interface SendMessageParams {
  to: string;
  message: string;
  phoneNumberId?: string;
}

export async function sendWhatsAppMessage({ to, message, phoneNumberId }: SendMessageParams): Promise<boolean> {
  console.log('sendWhatsAppMessage called with:', { to, message });
  const toNormalized = normalizePhone(String(to));
  if (toNormalized !== String(to)) {
    console.log(`Normalized recipient from ${to} -> ${toNormalized}`);
  }
  const { ok, data } = await post({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toNormalized,
    type: 'text',
    text: { body: message },
  }, { phoneNumberId });
  console.log('WhatsApp API returned for sendWhatsAppMessage:', JSON.stringify(data, null, 2));
  console.log(`📤 Sending message to ${to}: "${message}"`);
  if (ok) {
    const msgId = data?.messages?.[0]?.id;
    if (msgId) console.log(`✅ Text sent to ${to} (message_id: ${msgId})`);
    else console.log(`✅ Text sent to ${to} (no message_id in response)`);
  }
  else console.error('❌ WhatsApp API failed:', data);
  return ok;
}






export interface WhatsAppTemplateData {
  header?: string[];
  body?: string[];
  buttons?: string[];
}

export interface SendWhatsAppTemplateParams {
  to: string;
  templateId: string;
  templateData?: WhatsAppTemplateData;
  phoneNumberId?: string;
}

export async function sendWhatsAppTemplate({
  to,
  templateId,
  templateData,
  phoneNumberId,
}: SendWhatsAppTemplateParams): Promise<boolean> {
  console.log('sendWhatsAppTemplate called with:', {
    to,
    templateId,
    templateData,
  });

  const toNormalized = normalizePhone(String(to));

  const components: any[] = [];

  // HEADER VARIABLES
  if (templateData?.header?.length) {
    components.push({
      type: 'header',
      parameters: templateData.header.map((value) => ({
        type: 'text',
        text: String(value),
      })),
    });
  }

  // BODY VARIABLES
  if (templateData?.body?.length) {
    components.push({
      type: 'body',
      parameters: templateData.body.map((value) => ({
        type: 'text',
        text: String(value),
      })),
    });
  }

  // URL BUTTON VARIABLES
  if (templateData?.buttons?.length) {
    templateData.buttons.forEach((value, index) => {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: String(index),
        parameters: [
          {
            type: 'text',
            text: String(value),
          },
        ],
      });
    });
  }

  const templatePayload: any = {
    name: templateId,
    language: {
      code: 'en',
    },
  };

  if (components.length > 0) {
    templatePayload.components = components;
  }

  const { ok, data } = await post(
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toNormalized,
      type: 'template',
      template: templatePayload,
    },
    { phoneNumberId }
  );

  console.log(
    'WhatsApp API returned for sendWhatsAppTemplate:',
    JSON.stringify(data, null, 2)
  );

  if (ok && !data?.error) {
    const msgId = data?.messages?.[0]?.id;
    const status = data?.messages?.[0]?.message_status;
    if (msgId) {
      console.log(`✅ Template sent to ${toNormalized} (message_id: ${msgId}, status: ${status ?? 'accepted'})`);
    } else {
      console.log(`✅ Template sent to ${toNormalized}`);
    }
  } else {
    console.error('❌ WhatsApp template send failed:', JSON.stringify(data?.error || data, null, 2));
  }

  return ok && !data?.error;
}




export interface SendWhatsAppMessageOrTemplateParams {
  to: string;
  message?: string;
  templateId?: string;
  templateData?: WhatsAppTemplateData;

  phoneNumberId?: string;
}

export async function sendWhatsAppMessageOrTemplate({
  to,
  message,
  templateId,
  templateData,
  phoneNumberId,
}: SendWhatsAppMessageOrTemplateParams): Promise<boolean> {
  if (templateId) {
    return sendWhatsAppTemplate({
      to,
      templateId,
      templateData,
      phoneNumberId,
    });
  }

  return sendWhatsAppMessage({
    to,
    message: message || '',
    phoneNumberId,
  });
}



// ─── Mark message as read (turns grey ticks blue) ───────────────────────────
// POST to /messages with status=read and the incoming message_id.
export async function sendWhatsAppReadReceipt({ messageId, phoneNumberId }: { messageId: string; phoneNumberId?: string }): Promise<boolean> {
  try {
    if (!isWhatsAppMessageId(messageId)) {
      console.warn('⚠️ Skipping read receipt for non-WhatsApp message id:', messageId);
      return false;
    }

    const { url, headers } = getConfig({ phoneNumberId });
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
    if (res.ok) {
      console.log(`✅ Marked message ${messageId} as read`);
      return true;
    }
    const data = await res.json().catch(() => null);
    console.warn('⚠️ Read receipt failed:', data);
    return false;
  } catch (err) {
    console.error('❌ sendWhatsAppReadReceipt crashed:', err);
    return false;
  }
}


// ─── Typing indicator ───────────────────────────────────────────────────────
// Sends a typing indicator to the WhatsApp Cloud API.
// Requires the wamid of the incoming message being responded to.
export async function sendWhatsAppTyping({ to, messageId, phoneNumberId }: { to: string; messageId: string; phoneNumberId?: string }): Promise<boolean> {
  try {
    if (!isWhatsAppMessageId(messageId)) {
      console.warn('⚠️ Skipping typing indicator for non-WhatsApp message id:', messageId);
      return false;
    }

    const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';
    const resolvedPhoneNumberId = phoneNumberId || process.env.WHATSAPP_BUSINESS_PHONE_NUMBER_ID;
    if (!resolvedPhoneNumberId) throw new Error('Missing WHATSAPP_BUSINESS_PHONE_NUMBER_ID');
    const url = `https://graph.facebook.com/${apiVersion}/${resolvedPhoneNumberId}/messages`;
    const { headers } = getConfig();
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      }),
    });

    let data: any = null;
    try { data = await res.json(); } catch (e) { data = await res.text().catch(() => null); }

    if (res.ok) {
      console.log(`💬 Sent typing indicator to ${to}`);
      return true;
    }

    console.warn('❌ Typing indicator failed:', data);
    return false;
  } catch (err) {
    console.error('❌ sendWhatsAppTyping crashed:', err);
    return false;
  }
}

// ─── 2. Interactive button survey (max 3 buttons) ────────────────────────────
export async function sendWhatsAppSurvey({
  to,
  question,
  options,
  headerText,
  footerText,
  phoneNumberId,
}: SendSurveyParams & { options?: { id: string; title: string }[]; phoneNumberId?: string }): Promise<boolean> {
  const safeString = (v: any, fallback = '') => String(v ?? fallback);

  if (!question) {
    console.error('❌ Missing survey question');
    return false;
  }

  const safeOptions = (options ?? [])
    .filter(opt => opt?.id && opt?.title)
    .slice(0, 3);

  try {
    let payload: any;

    // ─── CASE 1: TEXT QUESTION (NO OPTIONS) ───
    const toNormalized = normalizePhone(String(to));
    if (toNormalized !== String(to)) {
      console.log(`Normalized recipient from ${to} -> ${toNormalized}`);
    }

    if (safeOptions.length === 0) {
      payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: toNormalized,
        type: 'text',
        text: {
          body: safeString(question),
        },
      };

      const { ok, data } = await post(payload, { phoneNumberId });

      if (ok) console.log(`📝 Text survey sent to ${to}`);
      else console.error('❌ WhatsApp API failed:', data);

      return ok;
    }

    // ─── CASE 2: BUTTON QUESTION (1–3 OPTIONS) ───
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toNormalized,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: safeString(question) },
        action: {
          buttons: safeOptions.map(opt => ({
            type: 'reply',
            reply: {
              id: opt.id,
              title: safeString(opt.title).substring(0, 50),
            },
          })),
        },
        header: headerText
          ? { type: 'text', text: safeString(headerText).substring(0, 60) }
          : undefined,
        footer: footerText
          ? { text: safeString(footerText).substring(0, 60) }
          : undefined,
      },
    };

    const { ok, data } = await post(payload, { phoneNumberId });

    if (ok) console.log(`✅ Survey sent to ${to}: "${question}"`);
    else console.error('❌ WhatsApp API failed:', data);

    return ok;
  } catch (err) {
    console.error('❌ sendWhatsAppSurvey crashed:', err);
    return false;
  }
}




export interface ListSection {
  title: string;
  rows: { id: string; title: string; description?: string }[];
}

export interface SendListParams {
  to: string;
  headerText?: string;
  bodyText: string;
  footerText?: string;
  buttonText: string;
  sections: ListSection[];
  phoneNumberId?: string;
}



export async function sendWhatsAppList({
  to,
  headerText,
  bodyText,
  footerText,
  buttonText,
  sections,
  phoneNumberId,
}: SendListParams): Promise<boolean> {
  const interactive: Record<string, unknown> = {
    type: 'list',
    body: { text: bodyText },
    action: {
      button: buttonText.substring(0, 20),
      sections: sections.map(s => ({
        title: s.title.substring(0, 24),
        rows: s.rows.map(r => ({
          id: r.id,
          title: r.title.substring(0, 24),
          description: r.description ? r.description.substring(0, 72) : undefined,
        })),
      })),
    },
  };

  if (headerText) interactive.header = { type: 'text', text: headerText.substring(0, 60) };
  if (footerText) interactive.footer = { text: footerText.substring(0, 60) };

  const { ok } = await post({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive,
  }, { phoneNumberId });
  if (ok) console.log(`✅ List message sent to ${to}`);
  return ok;
}

// ─── 4. Template message (for proactive/out-of-window messages) ──────────────

export interface TemplateParam {
  type: 'text' | 'image' | 'document' | 'video';
  text?: string;
  parameter_name?: string;
  image?: { link: string };
  document?: { link: string; filename?: string };
  video?: { link: string };
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  sub_type?: 'quick_reply' | 'url';
  index?: number;
  parameters?: TemplateParam[];
}




// ─── 5. Mark message as read ─────────────────────────────────────────────────

export async function markAsRead(messageId: string, phoneNumberId?: string): Promise<boolean> {
  if (!isWhatsAppMessageId(messageId)) {
    console.warn('⚠️ Skipping markAsRead for non-WhatsApp message id:', messageId);
    return false;
  }

  const { ok } = await post({
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  }, { phoneNumberId });
  return ok;
}
