---
name: engagement-agent
description: "Development skill for the FBNBank Senegal WhatsApp Customer Engagement Agent. Covers agent architecture, tool usage (escalate-to-human), memory configuration, WhatsApp formatting rules, security constraints, escalation flow, multilingual support, and testing patterns. Load this skill whenever modifying engagement-agent.ts or its connected tools and handlers."
license: Apache-2.0
metadata:
  author: Firstbank Senegal
  version: "1.0.0"
  domain: customer-engagement
  platform: WhatsApp Business API
  capabilities:
    - whatsapp-messaging
    - escalation
    - conversational-ai
    - memory
    - banking-faq
    - multilingual
  model_preferences:
    reasoning: high
    latency: medium
---

# Engagement Agent Skill

## Purpose

The `engagementAgent` is the primary customer-facing AI agent for **FBNBank Senegal** (First Bank of Nigeria group subsidiary). It handles all inbound WhatsApp conversations: FAQs, digital banking guidance, survey interaction acknowledgment, and escalation to human representatives.

Agent file: `src/mastra/agents/engagement-agent.ts`

---

## Architecture

```
WhatsApp Webhook
      │
      ▼
webhook/router.ts          ← routes by session state
      │
      ├── handleSurveyMessage()   ← if active survey session
      │
      └── handleChatMessage()     ← all other messages
               │
               ▼
         engagementAgent.generate()
               │
               ├── memory (PostgresStore) ← per-thread conversation history
               └── escalateTool           ← when escalation is triggered
```

---

## Agent Configuration

| Property     | Value                                               |
|--------------|-----------------------------------------------------|
| ID           | `engagement-agent`                                  |
| Model        | `getChatModel()` — see `src/mastra/core/llm/provider.ts` |
| Memory       | `PostgresStore` (`engagement-agent-memory`)         |
| Tools        | `escalateTool`                                      |
| Thread key   | customer phone number (normalised)                  |

---

## Tools

### `escalate-to-human` (`src/mastra/tools/escalate-to-human.ts`)

Creates a support ticket in the `escalations` database table.

**Input schema:**
```ts
{
  message: string;           // summary of the customer's issue
  category: 'complaint' | 'enquiry' | 'request';
  customerPhone: string;     // REQUIRED — the customer's account-registered phone number
}
```

> **`customerPhone` is required.** If the agent does not have it from context, it must ask:
> "To create your ticket, I need the phone number linked to your FBNBank account. Please note this must be the number registered on your account, not just your WhatsApp number."
> Only call the `escalate-to-human` tool once the customer has provided their account phone number.

**Output schema:**
```ts
{
  success: boolean;
  ticketId?: string;   // e.g. "TICKET-A3B9C2D1E"
}
```

**When the agent MUST call this tool:**
- User explicitly says "escalate", "speak to a human", "connect me to an agent", or equivalent in English or French.
- User expresses frustration (e.g. "this is ridiculous", "you're useless", "c'est nul").
- Query involves a transaction dispute, blocked account, or failed transfer.
- User repeats the same question more than once.
- The agent cannot give a grounded, accurate answer.


**After successful escalation:**
> "I have created a ticket for your request. A customer service representative will review it shortly. For immediate assistance, you can also call us at +234 1 905 2326."


**After failed escalation (tool returns `success: false`):**
> "🔒 For your security, I cannot process this request here. Please call our customer service at +234 1 905 2326 or visit your nearest FBNBank branch."

---

## WhatsApp Formatting Rules

These are HARD constraints — WhatsApp does not render standard Markdown.

| Rule | Detail |
|------|--------|
| No `**bold**` or `_italic_` | Not rendered in WhatsApp |
| No `[links](url)` | Not rendered in WhatsApp |
| Max 150 words per response | Mobile readability |
| Short paragraphs (2–3 sentences) | Scannable on mobile screens |
| Numbered lists for steps | e.g. `1. Open the app` |
| Bullet points with `•` | NOT `-` or `*` |
| Line break between sections | Improves readability |
| Emoji used naturally | 👋 ✅ 🏦 📱 🔐 ⚠️ 😊 |

---

## Security Constraints

The agent must NEVER:
- Ask for or accept account numbers, PINs, CVVs, OTPs, or passwords.
- Make promises about loan/credit approvals or quote specific interest rates.
- Provide financial advice beyond general product descriptions.

If a user shares sensitive data (e.g. card number, PIN):

> "⚠️ Please DELETE your previous message immediately — FBNBank will never ask for [PIN/card number/OTP] on WhatsApp. Your security is our top priority 🔒"

---

## Multilingual Support

The agent responds in the **same language the customer uses**. FBNBank Senegal serves both English-speaking and French-speaking customers.

- Detect language from the first message.
- Maintain the same language throughout the conversation thread.
- Use the same WhatsApp formatting rules in both languages.

---

## Memory

Each conversation is stored per-thread (phone number as thread ID) in PostgreSQL via `@mastra/pg`. This enables:

- **Personalisation**: greet returning customers by name.
- **Context continuity**: remember what was discussed earlier in the conversation.
- **Survey context**: understand follow-up messages after a survey is sent.

Memory is initialised as:
```ts
memory: new Memory({ storage: pgStore })
```

where `pgStore = new PostgresStore({ id: 'engagement-agent-memory', connectionString: process.env.DATABASE_URL })`.

---

## Response Patterns

### Greeting (new customer)
```
👋 Hello! Welcome to FBNBank Senegal support. I am your Virtual Customer Agent.

How can I assist you today? 😊
```

### Greeting (returning customer, name in memory)
```
👋 Welcome back [Name]! How can I assist you today? 😊
```

### Step-by-step procedure
```
Here's how to reset your mobile banking password:

1. Open the FBNBank mobile app 📱
2. Tap "Forgot Password" on the login screen
3. Enter your registered phone number or email
4. Follow the verification link to create a new password 🔐

Is there anything else I can help you with? 😊
```

### Menu / topic list
```
Here's what I can help you with today 😊

• 🏦 Accounts & Products
• 💳 Cards, transfers & transactions
• 📱 FBN Mobile & digital services
• 📍 Agencies & Contacts
• 💰 Loans & financing
• 📣 Complaints
• 🔒 Security
• 🧑‍💼 Talk to an advisor

Which of these can I help you with?
```

### Closing
Always end with an invitation to continue:
```
Is there anything else I can help you with? 😊
```

---

## Escalation Flow

```
1. Detect escalation trigger (explicit request, frustration, unknown query)
   │
2. Acknowledge and ask for confirmation
   "This may require assistance from a human agent. Would you like me to escalate this?"
   │
3a. User confirms → call escalateTool
     → On success: give ticket ID message
     → On failure: give hotline fallback message
   │
3b. User declines → try best-effort answer or ask for clarification
```

---

## Development Checklist

When modifying the engagement agent:

- [ ] Load the `mastra` skill first — check current `Agent` constructor signature in `node_modules/@mastra/core/dist/docs/`
- [ ] Ensure `escalateTool` remains in the `tools` object on the agent
- [ ] Keep instructions under the WhatsApp 150-word-per-response guideline
- [ ] Do not add Markdown formatting (`**`, `_`, `[]()`) to the instructions
- [ ] Test escalation by sending "I want to speak to a human" in a test thread
- [ ] Test PII detection by sending a fake card number
- [ ] Verify French-language responses by switching message language
- [ ] Run `pnpm build` to verify TypeScript compiles cleanly

---

## Testing

### Manual test via webhook
Run `pnpm webhook` and send messages through the WhatsApp sandbox number.

Key test scenarios:

| Scenario | Expected behaviour |
|----------|--------------------|
| "Hi" from new customer | Warm greeting, ask for name |
| "Hi" from returning customer | Personalised greeting using stored name |
| "How do I reset my PIN?" | Step-by-step instructions, no sensitive data request |
| "Transfer failed, I want to complain" | Offer escalation, then call escalateTool on confirmation |
| "I want to speak to a human" | Immediately call escalateTool |
| Message with a fake card number | Security warning, ask user to delete message |
| Message in French | Respond entirely in French |

---

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `escalateTool` returns `success: false` | DB table `escalations` missing | Run `db-init.ts` or check migration |
| Agent loses context between messages | Thread ID not consistent | Ensure `phone` is normalised via `normalizePhone()` before use as thread key |
| Agent responds with Markdown (`**text**`) | Model ignoring instruction | Strengthen formatting constraint in system prompt |
| French messages get English responses | Language detection missed | Add explicit instruction: "Detect language from first word of each message" |
