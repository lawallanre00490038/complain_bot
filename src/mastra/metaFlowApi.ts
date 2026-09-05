/**
 * metaFlowApi.ts
 *
 * Meta WhatsApp Cloud API helpers for creating, managing, and sending Flows.
 * https://developers.facebook.com/docs/whatsapp/flows
 */
import fetch from 'node-fetch';
import fs from 'fs';
import FormData from 'form-data';

const META_GRAPH_URL = 'https://graph.facebook.com/v18.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_BUSINESS_PHONE_NUMBER_ID;
const WHATSAPP_BUSINESS_ACCOUNT_ID = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

function authHeader() {
  return { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` };
}

// ─── Flow Management ──────────────────────────────────────────────────────────

/** Create a new (empty) Meta Flow under the business account */
export async function createMetaFlow(
  flowName: string,
  categories: string[] = ['SURVEY'],
): Promise<string> {
  const url = `${META_GRAPH_URL}/${WHATSAPP_BUSINESS_ACCOUNT_ID}/flows`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: flowName, categories }),
  });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(`Meta Flow creation failed: ${JSON.stringify(err)}`);
  }
  const data = await res.json() as any;
  return data.id as string;
}

/** Upload Flow JSON from a file path */
export async function uploadFlowJson(flowId: string, jsonPath: string): Promise<any> {
  const graphAssetsUrl = `${META_GRAPH_URL}/${flowId}/assets`;
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', fs.createReadStream(jsonPath), 'survey.json');
  const res = await fetch(graphAssetsUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Upload flow.json failed: ${res.statusText}`);
  return await res.json() as any;
}

/** Upload Flow JSON from an in-memory Buffer (no temp file needed) */
export async function uploadFlowJsonBuffer(flowId: string, jsonBuffer: Buffer): Promise<any> {
  const url = `https://graph.facebook.com/v18.0/${flowId}/assets`;

  const form = new FormData();

  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');

  // ✅ CRITICAL FIX
  form.append('file', jsonBuffer, {
    filename: 'flow.json',
    contentType: 'application/json'
  });

  const res = await fetch(url, {
    method: 'POST',

    // ✅ CRITICAL FIX — include form headers
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      ...form.getHeaders()
    },

    body: form
  });

  const data = await res.json();
  console.log("✅ UPLOAD RESPONSE:", data);

  if (!res.ok) {
    throw new Error(`Upload failed: ${JSON.stringify(data)}`);
  }

  return data;
}



export async function publishFlow(flowId: string): Promise<any> {
  const META_GRAPH_URL = 'https://graph.facebook.com/v22.0';
  const endpointUrl = `${process.env.SERVER_URL}/webhook/meta-flow-data`;

  console.log("Setting endpoint_uri:", endpointUrl);

  // STEP 1: Update Flow
  const updateRes = await fetch(`${META_GRAPH_URL}/${flowId}`, {
    method: 'POST',
    headers: {
      ...authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      endpoint_uri: endpointUrl,
    }),
  });

  const updateData = await updateRes.json();
  console.log("Update response:", updateData);

  if (!updateRes.ok) {
    throw new Error(`Pre-publish update failed: ${JSON.stringify(updateData)}`);
  }


  // 🛑 CRITICAL: Wait for Meta to propagate the URI change
  console.log("⏳ Waiting 5 seconds for endpoint propagation...");
  await new Promise(resolve => setTimeout(resolve, 5000));

  //  STEP 1.5 — VERIFY WHAT META STORED
  const verifyRes = await fetch(`${META_GRAPH_URL}/${flowId}`, {
    method: 'GET',
    headers: authHeader(),
  });

  const verifyData = await verifyRes.json();
  console.log("Flow after update:", verifyData);

  // STEP 2: Publish
  const res = await fetch(`${META_GRAPH_URL}/${flowId}/publish`, {
    method: 'POST',
    headers: authHeader(),
  });

  const data = await res.json();
  console.log("Publish response:", data);

  if (!res.ok) {
    throw new Error(`Publish flow failed: ${JSON.stringify(data)}`);
  }

  return data;
}



/** Deprecate a published Flow (soft-delete; responses already collected are kept) */
export async function deprecateFlow(flowId: string): Promise<any> {
  const url = `${META_GRAPH_URL}/${flowId}/deprecate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeader(),
  });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(`Deprecate flow failed: ${JSON.stringify(err)}`);
  }
  return await res.json();
}

/** Hard-delete a Flow (only works on DRAFT flows that were never published) */
export async function deleteFlow(flowId: string): Promise<any> {
  const url = `${META_GRAPH_URL}/${flowId}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: authHeader(),
  });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(`Delete flow failed: ${JSON.stringify(err)}`);
  }
  return await res.json();
}

/** Get details of a single Flow including validation errors */
export async function getFlow(flowId: string): Promise<any> {
  const url = `${META_GRAPH_URL}/${flowId}?fields=id,name,status,categories,validation_errors,preview.fields(preview_url,expires_at)`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(`Get flow failed: ${JSON.stringify(err)}`);
  }
  return await res.json();
}

/** List all Flows for the WhatsApp Business Account */
export async function listFlows(): Promise<any> {
  const url = `${META_GRAPH_URL}/${WHATSAPP_BUSINESS_ACCOUNT_ID}/flows?fields=id,name,status,categories,preview.fields(preview_url,expires_at)`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(`List flows failed: ${JSON.stringify(err)}`);
  }
  return await res.json();
}



// ─── Sending Flows ────────────────────────────────────────────────────────────

/**
 * Sends an interactive WhatsApp Flow message to a customer.
 * The customer will see a CTA button that opens the Flow inside WhatsApp.
 *
 * @param to           Recipient phone in E.164 format without '+' (e.g. "2349013360717")
 * @param flowId       Meta Flow ID (returned by createMetaFlow)
 * @param flowToken    Unique token for this session (used to correlate the submission)
 * @param cta          CTA button label (max 20 chars), e.g. "Take Survey"
 * @param headerText   Optional header text shown above the message body
 * @param bodyText     Message body text shown to the user
 * @param footerText   Optional footer text
 * @param phoneNumberId  WhatsApp phone number ID (defaults to env var)
 */
export async function sendFlowMessage(params: {
  to: string;
  flowId: string;
  flowToken: string;
  cta: string;
  headerText?: string;
  bodyText?: string;
  footerText?: string;
  flowMode?: 'draft' | 'published';
  phoneNumberId?: string;
}): Promise<any> {
  const pid = params.phoneNumberId || PHONE_NUMBER_ID;
  const url = `${META_GRAPH_URL}/${pid}/messages`;

  const interactive: any = {
    type: 'flow',
    body: { text: params.bodyText || 'Please take a moment to complete our survey.' },
    action: {
      name: 'flow',
      parameters: {
        flow_message_version: '3',
        flow_token: params.flowToken,
        flow_id: params.flowId,
        ...(params.flowMode ? { mode: params.flowMode } : {}),
        flow_cta: params.cta.substring(0, 20),
        flow_action: 'navigate',
        flow_action_payload: { screen: 'INTRO' },
      },
    },
  };

  if (params.headerText) {
    interactive.header = { type: 'text', text: params.headerText.substring(0, 60) };
  }
  if (params.footerText) {
    interactive.footer = { text: params.footerText.substring(0, 60) };
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: params.to,
    type: 'interactive',
    interactive,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(`Send flow message failed: ${JSON.stringify(err)}`);
  }
  return await res.json();
}
