// import { AIMessage } from "@langchain/core/messages";
// import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
// import { describe, expect, it } from "vitest";

// import { formatForTelegram } from "../telegram-ui.js";
// import {
//   buildStartHistoryText,
//   hasUpcomingVisit,
//   loadWelcomeMessage,
//   recordWelcomeInHistory,
//   WELCOME_HISTORY_MARKER,
// } from "../welcome-message.js";
// import { runWithTelegramUserId } from "../../tools/telegram-user-context.js";

// describe("welcome message", () => {
//   const crmHours = JSON.stringify({
//     calendars: [
//       {
//         timeRanges: [["11:00", "15:00"]],
//         weekdays: {
//           "0": false,
//           "1": true,
//           "2": true,
//           "3": true,
//           "4": true,
//           "5": true,
//           "6": false,
//         },
//       },
//     ],
//   });

//   const loadWithHours = (hoursJson: string) =>
//     loadWelcomeMessage(async () => JSON.parse(hoursJson) as unknown, "user-1");

//   it("includes intro, categorized services, and CRM hours without prices", async () => {
//     const message = await loadWithHours(crmHours);
//     expect(message).toContain("Катерини Федченко");
//     expect(message).toContain("Консультації та дерматологія");
//     expect(message).toContain("Консультація дерматолога-косметолога");
//     expect(message).toContain("Ін'єкційна косметологія");
//     expect(message).toContain("Біоревіталізація");
//     expect(message).toContain("Скинкери");
//     expect(message).toContain("Понеділок–П'ятниця: 11:00–15:00");
//     expect(message).toContain("Субота–Неділя: вихідний");
//     expect(message).toContain("вул. Миколаївська 33, м. Білгород-Дністровський");
//     expect(message).toContain(
//       "[Google maps](https://www.google.com/maps/place/Mukolayivska+St,+33,+Bilhorod-Dnistrovs'kyi,+Odes'ka+oblast,+Ukraine,+67701)",
//     );
//     expect(message).not.toMatch(/UAH|USD|\$|грн/i);
//   });

//   it("formats CRM weekday-specific ranges", async () => {
//     const message = await loadWithHours(
//       JSON.stringify({
//         calendars: [
//           {
//             timeRanges: [["09:00", "18:00"]],
//             weekdays: {
//               "0": false,
//               "1": true,
//               "2": true,
//               "3": true,
//               "4": true,
//               "5": true,
//               "6": false,
//             },
//             weekdayTimeRanges: {
//               "5": [["09:00", "14:00"]],
//             },
//           },
//         ],
//       }),
//     );
//     expect(message).toContain("Понеділок–Четвер: 09:00–18:00");
//     expect(message).toContain("П'ятниця: 09:00–14:00");
//     expect(message).toContain("Субота–Неділя: вихідний");
//   });

//   it("does not use clinic-constant fallback hours when CRM fails", async () => {
//     expect((await loadWithHours(JSON.stringify({ error: "MCP down" }))).includes(
//       "Час роботи наразі недоступний.",
//     )).toBe(true);
//     expect((await loadWithHours("{}")).includes("Час роботи наразі недоступний.")).toBe(true);
//   });

//   it("loadWelcomeMessage reads hours via get_working_time", async () => {
//     const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
//     const message = await loadWelcomeMessage(async (name, args) => {
//       calls.push({ name, args });
//       return JSON.parse(crmHours) as unknown;
//     }, "user-1");

//     expect(calls).toEqual([{ name: "get_working_time", args: { userId: "user-1" } }]);
//     expect(message).toContain("Понеділок–П'ятниця: 11:00–15:00");
//   });

//   it("formats to Telegram HTML with bold headings and bullets", async () => {
//     const html = formatForTelegram(await loadWithHours(crmHours));
//     expect(html).toContain("<b>Години роботи</b>");
//     expect(html).toContain("• Консультація дерматолога-косметолога");
//     expect(html).toContain("• Понеділок–П'ятниця: 11:00–15:00");
//     expect(html).toContain(
//       '<a href="https://www.google.com/maps/place/Mukolayivska+St,+33,+Bilhorod-Dnistrovs\'kyi,+Odes\'ka+oblast,+Ukraine,+67701">Google maps</a>',
//     );
//   });
// });

// describe("recordWelcomeInHistory", () => {
//   it("appends the welcome as an AIMessage on the chat thread", async () => {
//     const state = Annotation.Root({
//       messages: Annotation<unknown[]>({
//         reducer: (left: unknown[], right: unknown[]) => left.concat(right),
//         default: () => [],
//       }),
//     });
//     const graph = new StateGraph(state)
//       .addNode("noop", async () => ({}))
//       .addEdge(START, "noop")
//       .addEdge("noop", END)
//       .compile({ checkpointer: new MemorySaver() });

//     const threadId = "welcome-history-1";
//     const welcome = buildStartHistoryText("Clinic intro");
//     expect(welcome).toContain(WELCOME_HISTORY_MARKER);
//     expect(welcome).not.toContain("Clinic intro");
//     await recordWelcomeInHistory(graph, threadId, welcome);

//     const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
//     const messages = snapshot.values.messages as AIMessage[];
//     expect(messages).toHaveLength(1);
//     expect(messages[0]).toBeInstanceOf(AIMessage);
//     expect(messages[0]?.content).toBe(welcome);
//     expect(String(messages[0]?.content)).toContain(WELCOME_HISTORY_MARKER);
//   });
// });

// describe("hasUpcomingVisit", () => {
//   it("is false when there is no contact", async () => {
//     await runWithTelegramUserId("tg-1", async () => {
//       expect(await hasUpcomingVisit(async () => ({ contacts: [] }))).toBe(false);
//     });
//   });

//   it("is true when planned meetings exist", async () => {
//     await runWithTelegramUserId("tg-1", async () => {
//       expect(
//         await hasUpcomingVisit(async (name) => {
//           if (name === "search_contacts") {
//             return { success: true, contacts: [{ id: "c-1" }] };
//           }
//           return {
//             list: [
//               {
//                 id: "m-1",
//                 name: "Consult",
//                 dateStart: "2026-08-25T11:00:00",
//                 dateEnd: "2026-08-25T11:30:00",
//               },
//             ],
//           };
//         }),
//       ).toBe(true);
//     });
//   });
// });
