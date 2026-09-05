---
name: survey-agent
description: "Development skill for the FBNBank WhatsApp Survey Designer Agent. Covers agent purpose, output format specification, WhatsApp Business API constraints (max 3 buttons, 20-char option limit), question type taxonomy, integration with the survey workflow and survey templates, structured output usage, and testing patterns. Load this skill whenever modifying survey-agent.ts, survey-workflow.ts, surveyTemplates.ts, or any survey delivery/sending utilities."
license: Apache-2.0
metadata:
  author: Firstbank Senegal
  version: "1.0.0"
  domain: survey-design
  platform: WhatsApp Business API
  capabilities:
    - whatsapp-interactive-messages
    - structured-output
    - survey-generation
    - nlp
    - banking-cx
  model_preferences:
    reasoning: high
    latency: medium
---

# Survey Agent Skill

## Purpose

The `surveyAgent` is a specialist AI agent responsible for **designing WhatsApp-compatible survey questions** for FBNBank. It takes a topic or context and returns structured JSON output containing survey questions and answer options that are ready to be delivered as WhatsApp interactive messages.

This agent generates content only — it does NOT send messages. Sending is handled downstream by the survey workflow and `sendSurveyQuestion()`.

Agent file: `src/mastra/agents/survey-agent.ts`

---

## Architecture

```
Admin API or Workflow trigger
      │
      ▼
survey-workflow.ts → generateSurveyContent step
      │
      ├── mode: 'manual'  → loads from data/<surveyId>.json or surveyTemplates.ts
      │
      └── mode: 'ai'      → calls surveyAgent.generate() with structured output
                                │
                                ▼
                         surveyAgent (LLM)
                                │
                                ▼
                     JSON: { questions: [...] }
                                │
                                ▼
              sendSurveyQuestion() → WhatsApp Business API
```

---

## Agent Configuration

| Property  | Value                                                     |
|-----------|-----------------------------------------------------------|
| ID        | `survey-agent`                                            |
| Model     | `getChatModel()` — see `src/mastra/core/llm/provider.ts`  |
| Memory    | `PostgresStore` (`survey-agent-memory`)                   |
| Tools     | None — pure generation agent                              |
| Output    | Structured JSON via `structuredOutput` schema in workflow |

---

## WhatsApp Business API Hard Constraints

These are platform limits that CANNOT be exceeded. Any violation will cause the WhatsApp API to reject the message.

| Constraint | Limit | Applies To |
|------------|-------|------------|
| Max reply buttons per message | **3** | `button` type questions |
| Max button title length | **20 characters** (including emoji) | Each option string |
| Max list sections | **10** | `list` type questions |
| Max list items per section | **10** | `list` type questions |
| Max list item title length | **24 characters** | Each list option |
| Body text (question) max length | **1024 characters** | Question text (keep under 200 for mobile readability) |

**The 3-button and 20-character rules are the most critical.** Always verify generated options against these before sending.

---

## Output Format

The agent always returns valid JSON. The workflow uses Zod `structuredOutput` to enforce this.

### Single question
```json
{
  "question": "📱 How satisfied are you with FBNBank mobile app?",
  "options": ["Very Satisfied 😊", "Neutral 😐", "Dissatisfied 😞"]
}
```

### Multi-question survey (preferred for topics)
```json
{
  "questions": [
    {
      "question": "🏦 How was your account opening experience?",
      "options": ["Very Easy ⭐", "Average 😐", "Difficult 😞"]
    },
    {
      "question": "📋 Were the required documents clear to understand?",
      "options": ["Yes ✅", "No ❌", "Somewhat 🤔"]
    },
    {
      "question": "⏱️ Was the account opening timeline as expected?",
      "options": ["Yes ✅", "No ❌"]
    }
  ]
}
```

### Option length validation (always check before sending)
```ts
// Each option must be ≤ 20 chars
options.every(opt => [...opt].length <= 20)
```
> Note: Use `[...opt].length` not `opt.length` — emoji count as 1–2 code units but are 1 visual character. WhatsApp counts by display length.

---

## Question Types

The survey system supports three WhatsApp message types:

### `button` — Interactive reply buttons
- Max **3** options
- Each option ≤ **20 characters**
- Best for: yes/no, simple satisfaction, NPS-lite
- Example options: `"Yes ✅"`, `"No ❌"`, `"Maybe 🤔"`

### `list` — Interactive list picker
- Max **10 sections**, up to **10 items per section**
- Each item title ≤ **24 characters**
- Best for: multiple-choice with more than 3 options, branch selection, service categories
- Requires `sectionTitle` in template format

### `text` — Open-ended free text
- No option constraints
- Best for: qualitative feedback, suggestions, comments
- Requires `placeholder` in template format
- Agent does NOT generate options for text questions

---

## Question Design Guidelines

When generating questions, the agent follows these principles:

### Do
- Use emoji in question text to make it visually engaging on mobile (📊 ✅ 🏦 💬 ⭐ 📱)
- Keep question text under **200 characters** for mobile readability
- Use neutral, unbiased language
- Cover one dimension per question (satisfaction OR ease OR speed — not all three at once)
- Include at least 2 questions per survey topic for meaningful data
- Match answer options to the question's scale (don't mix yes/no options with a satisfaction question)

### Do NOT
- Generate leading questions ("Don't you think our service is great?")
- Ask for account numbers, PINs, balances, or any PII
- Use Markdown formatting in questions or options
- Generate more than 3 options for `button` type questions
- Generate options longer than 20 characters for `button` type

---

## Supported Question Patterns

| Pattern | Example Question | Example Options |
|---------|-----------------|-----------------|
| Satisfaction scale | "How satisfied are you with our service?" | "Very Satisfied 😊", "Neutral 😐", "Dissatisfied 😞" |
| Yes/No | "Was the staff helpful during your visit?" | "Yes ✅", "No ❌" |
| Yes/No/Maybe | "Would you recommend FBNBank to a friend?" | "Yes ✅", "No ❌", "Maybe 🤔" |
| Rating | "How would you rate your branch experience?" | "Excellent ⭐", "Good 👍", "Poor 👎" |
| NPS-lite | "How likely are you to use our app again?" | "Likely 🟢", "Maybe 🟡", "Unlikely 🔴" |
| Speed | "How was the waiting time at the branch?" | "Short ✅", "Reasonable 😐", "Too Long 😞" |

---

## Integration with Survey Workflow

The survey workflow (`src/mastra/workflows/survey-workflow.ts`) calls the survey agent in AI mode via structured output:

```ts
const response = await agent.generate(
  [{ role: 'user', content: prompt }],
  {
    structuredOutput: {
      schema: z.object({
        questions: z.array(z.object({
          question: z.string(),
          options: z.array(z.string()),
        })).optional(),
        question: z.string().optional(),
        options: z.array(z.string()).optional(),
      }),
    },
    memory: {
      thread: `survey_thread_${Date.now()}`,
      resource: `survey_${inputData.surveyId || 'default'}`,
    },
  }
)
```

The agent must always return output that matches one of these two shapes:
1. `{ questions: [...] }` — multi-question
2. `{ question: string, options: string[] }` — single question

---

## Survey Templates (Manual Mode)

For non-AI surveys, templates are defined in `src/surveyTemplates.ts`. These bypass the agent entirely and are served directly from a static array or from `data/<surveyId>.json` files.

When adding new manual survey templates:
1. Add to `surveyTemplates.ts` following the `SurveyTemplate` interface
2. Or create `data/<surveyId>.json` with `{ questions: [...] }` shape
3. The workflow's `mode: 'manual'` path will pick it up automatically

---

## Development Checklist

When modifying the survey agent or related survey code:

- [ ] Load the `mastra` skill first — check current `Agent` constructor signature
- [ ] Verify all generated option strings are ≤ 20 characters (including emoji)
- [ ] Verify no question has more than 3 options when using `button` type
- [ ] Check `structuredOutput` schema in the workflow matches what the agent returns
- [ ] Do not add tools to this agent — it is a pure generation agent
- [ ] Test AI mode with at least 2 different banking topics
- [ ] Test manual mode by confirming template resolution works for a known survey ID
- [ ] Run `pnpm build` to verify TypeScript compiles cleanly

---

## Testing

### Test AI survey generation
Trigger the workflow in AI mode with a test topic:
```ts
const result = await mastra.getWorkflow('survey-workflow').execute({
  topic: 'Mobile banking app satisfaction',
  mode: 'ai',
})
```

### Test manual survey delivery
```ts
const result = await mastra.getWorkflow('survey-workflow').execute({
  surveyId: 'demo_survey_1',
  mode: 'manual',
})
```

### Key validation checks after generation

| Check | Pass condition |
|-------|---------------|
| All button options ≤ 20 chars | `opts.every(o => [...o].length <= 20)` |
| Max 3 options per button question | `opts.length <= 3` |
| Question has at least 2 options | `opts.length >= 2` |
| Question text has at least 1 emoji | `/\p{Emoji}/u.test(question)` |
| No PII in questions | No mention of account, PIN, password, balance |

---

## Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| WhatsApp rejects message | Button option > 20 chars | Shorten emoji+text combo; use `[...str].length` to measure |
| `Survey agent not found` in workflow | Agent not registered in `src/mastra/index.ts` | Register `surveyAgent` in Mastra agents map |
| `structuredOutput` schema mismatch | Agent returns `question` but schema expects `questions` | Both shapes are valid — ensure the Zod schema has both as `.optional()` |
| Manual survey not found | `surveyId` not in `surveyTemplates.ts` and no `data/<id>.json` | Add the template to `surveyTemplates.ts` |
| Empty questions array | LLM returned single-question format but workflow expected multi | Normalise output: if `question` exists, wrap in `[{ question, options }]` |
