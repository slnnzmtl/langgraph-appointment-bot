## Architecture Overview

**1. Core Stack:**
* Framework: `LangGraph.js` / `@langchain/core`
* Interface: Telegram Bot API (`telegraf` or `node-telegram-bot-api`)
* Backend/DB: EspoCRM (sibling MCP HTTP: `GET /health`, `POST /tools/:name`)
* Validation: `Zod` (for strict tool and state schemas)
* Model: Fast, strict-tool-calling models (e.g., `GPT-5.6 Luna` or `Gemini 3.5 Flash-Lite` for the Root Router; `GPT-5.6 Terra` or `Claude 5 Sonnet` for the Booking Graph)

**2. Topology (Supervisor + one specialist):**
* **Telegram Adapter:** Parses incoming messages, renders UI (reply keyboards from `<reply_buttons>` trailers), manages `thread_id` checkpointers for LangGraph.
* **Root Supervisor (Semantic Router + greeter):** A toolless node. Uses Zod structured output to classify into `booking` or `FINISH` (greet / list visits / small talk).
* **Booking Agent (Read/Write + FAQ):** Binds all EspoCRM MCP tools — catalog/prices/hours plus contact and meeting writes with HITL.

**3. State Management (AgentState):**
```typescript
interface AgentState {
  messages: BaseMessage[];
  current_intent: "booking" | "canceling" | null;
  draft_booking: {
     service_id?: string;
     date?: string; // YYYY-MM-DD
     time?: string; // HH:MM
     phone?: string;
     first_name?: string;
     last_name?: string;
  };
  missing_info: string[]; 
}
```

---

## MCP Tool Registry

The Booking node must bind to these specific tools exposed by our EspoCRM MCP server. Use LangChain's `ToolNode`; CRM I/O goes through MCP HTTP `/tools/:name`, not EspoCRM REST.

1. `espocrm_find_contact(telegram_id, phone_number)`: Returns contact ID if they exist.
2. `espocrm_create_contact(first_name, last_name, phone, telegram_id)`: Registers a new patient.
3. `espocrm_get_availability(date, service_duration)`: Queries calendar for open slots.
4. `espocrm_create_meeting(contact_id, start_time, end_time, service_id)`: Books the appointment.
5. `espocrm_delete_meeting(meeting_id)`: Cancels the appointment.

---

## Execution Phases

Execute the development in the following atomic phases. **Ask for my approval before moving to the next phase.**

### Phase 1: Scaffolding & State Setup
1. Initialize the TypeScript project and install necessary LangGraph, LangChain, Zod, and Telegram dependencies.
2. Create the strict `AgentState` schema using LangGraph's `StateGraph` channels (define reducers for appending messages and updating the `draft_booking` object).
3. Set up the `MemorySaver` checkpointer for conversation persistence based on Telegram `chat_id`.

### Phase 2: The MCP Bridge & Tool Nodes
1. Create an MCP client initialization script that connects to a generic local MCP server.
2. Expose the MCP tool registry functions as LangChain-compatible tools.
3. Create the `ToolNode` that will be executed by the Booking Sub-Graph.

### Phase 3: Nodes & Edges (The Core Graph)
1. **Supervisor Node:** Implement a `.withStructuredOutput()` call that forces the LLM to output `{"next_node": "booking" | "FINISH"}`.
2. **Booking Node:** Implement a ReAct or native tool-calling loop that answers clinic FAQ and evaluates booking state. If data is missing (like phone number), it asks the user. If data is complete, it triggers the MCP tools.
3. Compile the graph with appropriate conditional edges routing back to the user or to the tools.

### Phase 4: Telegram UI Adapter & Human-in-the-Loop
1. Wrap the compiled graph in a Telegram Bot webhook/polling loop.
2. **CRITICAL UI RULE:** When offering availability, use a two-step date-then-time flow. Booking finalize attaches the DATE then TIME **reply keyboards** from the `present_availability_slots` snapshot (the model must not invent hours or emit a DATE/TIME `<reply_buttons>` trailer). Tapping a label sends that text as a normal message (the user may still type a slot).
3. **CRITICAL SAFETY RULE (HITL):** Before writing a meeting (create / soft-cancel / reschedule), the graph must pause. The bot sends a confirmation caption with a ✅/❌ **reply keyboard**. Only proceed when the user taps ✅ (or affirms in chat and the model re-calls with `confirmationGiven: true`).

---

## Strict Constraints

1. **No monolithic files:** Split logic into `/core` (graph, state), `/tools` (MCP definitions), and `/adapter` (Telegram wrapper).
2. **Anti-Hallucination:** Ensure the Supervisor Node does not have access to execution tools, only routing schemas. Only the Booking Node gets the MCP tools.
3. **Turn Alternation:** Ensure LangGraph cleanly exits its loop and awaits user input rather than endlessly looping internally. Use `END` states explicitly after sending a Telegram message.