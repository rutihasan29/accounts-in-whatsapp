# LLM Incoming Message Classification & Dispatch Subsystem Design

**Date:** 2026-10-21  
**Status:** Approved by User  
**Target Project:** `D:\munnisoft-v2`  

---

## 1. Overview & Objectives

This subsystem adds intelligent message classification and dispatch to the WhatsApp Business bot. Incoming customer messages are analyzed alongside the recent conversation history (last 10 messages) using Google Gemini (`gemini-2.5-flash`).

### Core Business Objectives:
1. **Identify Voice Jobs Immediately:** When a customer sends a voiceover script with explicit voice/audio keywords, classify as `VOICE_JOB`, acknowledge with `ওকে`, and forward the extracted script to **VA2** (`8801307760509`).
2. **Clarify Unspecified Scripts:** When a customer sends a raw script without specifying the medium, ask the clarifying question: `শুধু ভয়েস? `.
3. **Handle Multi-turn Script Confirmations:** When the bot has asked `শুধু ভয়েস? ` and the customer responds affirmatively (`হ্যাঁ`, `জি`, `yes`, `shudu voice`), classify as `VOICE_JOB`, reply `ওকে`, and forward the script to **VA2**.
4. **Escalate Ambiguity & Complex Queries:** When a customer asks about video editing, pricing, revisions, or unclear requests, classify as `ESCALATE` and alert **VE3** (`8801831366604`) with the customer's phone number and message.
5. **Preserve Existing Bot Features:** Maintain zero interference with manual billing ledger commands (`1000 paid`, `15s bill`, `video bill`), audio duration tracking, and the 7-message Welcome Demo sequence.

---

## 2. Configuration & Contact Targets

- **LLM Provider:** Google Gemini API (`gemini-2.5-flash`)
- **API Key Environment Variable:** `GEMINI_API_KEY` (configured in `.env`)
- **Target Contacts:**
  - `VA2_PHONE`: `8801307760509` (JID: `8801307760509@c.us`)
  - `VE3_PHONE`: `8801831366604` (JID: `8801831366604@c.us`)

---

## 3. Architecture & Components

```
                Incoming Inbound Message (!msg.fromMe && !isSelf)
                                   │
                                   ▼
                   Is Group Chat (@g.us) or Self?
                           ├── Yes ──► Ignore
                           └── No
                                   │
                                   ▼
                    Is In-Flight Welcome Demo?
                           ├── Yes ──► Process Demo (do not classify)
                           └── No
                                   │
                                   ▼
             Fetch Last 10 Messages (chat.fetchMessages)
                                   │
                                   ▼
                    Gemini 2.5 Flash API Classifier
                      (src/classifier.js: classifyChat)
                                   │
         ┌─────────────────────────┼─────────────────────────┬───────────────┐
         │                         │                         │               │
         ▼                         ▼                         ▼               ▼
     VOICE_JOB          SCRIPT_PENDING_CONFIRMATION       ESCALATE         OTHER
         │                         │                         │               │
  • Send "ওকে"           • Send "শুধু ভয়েস? "       • Alert VE3     • No auto-action
  • Extract script                                     (+8801831366604)
  • Forward to VA2                                     with customer #
    (+8801307760509)                                   & query
```

### Module Responsibilities:
1. **`src/classifier.js`**:
   - `buildHistoryTranscript(messages)`: Formats recent messages into structured role tags (`[Customer]`, `[Bot]`).
   - `classifyChat({ messages, apiKey, timeoutMs })`: Calls Gemini API with structured JSON output schema and validates the verdict.
2. **`src/bot.js`**:
   - Hooks into `handleMessageCreate` for customer inbound messages.
   - Dispatches WhatsApp replies (`শুধু ভয়েস? ` or `ওকে`) and forwards payloads to `VA2` or alerts to `VE3`.
3. **`src/config.js`**:
   - Exports `GEMINI_API_KEY`, `VA2_PHONE`, and `VE3_PHONE` with fallbacks.

---

## 4. LLM Prompt Specification & Response Contract

### System Instruction:
```text
You are an expert message classifier for a WhatsApp audio/voice production agency.
Analyze the provided conversation history between the Customer and the Bot/Business.

Categories:
1. VOICE_JOB:
   - The Customer submits an ad script / voiceover text and explicitly requests voice or audio (e.g. "voice", "audio", "ভয়েস", "রেকর্ড", "voice lagbe").
   - OR, the Bot previously asked "শুধু ভয়েস?", and the Customer's latest message confirms affirmatively (e.g. "হ্যাঁ", "জি", "yes", "shudu voice", "hmm", "thik ache", "ok").
   Action: Extract the full text of the script into extracted_script.

2. SCRIPT_PENDING_CONFIRMATION:
   - The Customer provides a commercial, narration, or ad script without specifying whether they need voiceover, video editing, or both, and the Bot has NOT yet asked "শুধু ভয়েস?".

3. ESCALATE:
   - Questions about pricing, video editing, graphics, revisions, complaints, or ambiguous/complex queries where the intent cannot be determined with certainty.

4. OTHER:
   - Casual greetings (hi, hello, salam), payment proofs, or unrelated conversational chatter requiring no script dispatch.
```

### Strict JSON Response Schema:
```json
{
  "classification": "VOICE_JOB | SCRIPT_PENDING_CONFIRMATION | ESCALATE | OTHER",
  "confidence": "HIGH | LOW",
  "extracted_script": "string",
  "reason": "string"
}
```

---

## 5. Automated Forwarding Formats

### To VA2 on `VOICE_JOB`:
```text
[নতুন ভয়েস অর্ডার]
গ্রাহক: +<customer_phone><optional_customer_name>
স্ক্রিপ্ট:
<extracted_script>
```

### To VE3 on `ESCALATE`:
```text
[সহায়তা প্রয়োজন / Customer Escalation]
গ্রাহক: +<customer_phone><optional_customer_name>
মেসেজ: <latest_customer_message>
কারণ: <reason>
```

---

## 6. Guardrails & Error Handling

1. **API Timeout:** Set to 6,000ms. If network drops or API fails, fail safely: log error and fallback to `ESCALATE` alerting VE3.
2. **Loop Suppression:**
   - Outbound messages from bot (`msg.fromMe === true`) never trigger classification.
   - If the bot's immediate previous message was already `শুধু ভয়েস? `, customer reply is evaluated strictly as an answer.
3. **Non-Blocking Delivery:** Forwarding to VA2 and VE3 uses try/catch and error logging so failures in forwarding do not block customer responses.

---

## 7. Verification Plan

1. **Unit Tests (`tests/classifier.test.js`):**
   - Test transcript formatting with alternating roles.
   - Test `VOICE_JOB` classification with script and voice keyword.
   - Test `SCRIPT_PENDING_CONFIRMATION` classification for raw script.
   - Test multi-turn affirmative reply to "শুধু ভয়েস?".
   - Test `ESCALATE` on video inquiry or price questions.
   - Test API timeout and error fallback.
2. **Integration Tests (`tests/bot-classifier.test.js`):**
   - Test customer message triggers `classifyChat` and delivers correct action.
   - Verify `VA2` and `VE3` message send invocations.
3. **Full Regression Test:**
   - Execute `npm test` verifying all 128 existing tests + new classifier tests pass.
