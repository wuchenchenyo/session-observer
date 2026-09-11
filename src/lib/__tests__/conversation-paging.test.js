import { describe, expect, test } from "vitest";
import { buildConversationTurns } from "../conversation-models";
import {
  CONVERSATION_PAGE_LIMIT,
  createEmptyConversationPage,
  mergeConversationPage,
  sliceConversationPage,
} from "../conversation-paging";

describe("conversation-paging", () => {
  test("restores file order across reverse pages with session-time fallback", () => {
    const base = { sourceType: "grok", sourceFile: "/synthetic/chat_history.jsonl", sourceLine: 0, time: "2026-09-11T00:00:00Z", timeSource: "session" };
    const newest = mergeConversationPage([], createEmptyConversationPage(), [
      { ...base, sourceOffset: 200, callType: "Agent", content: "Done" },
      { ...base, sourceOffset: 100, callType: "Tool_Result", content: "sample.txt", toolName: "list_files" },
    ], { total: 4, replace: true });
    const combined = mergeConversationPage(newest.events, newest.page, [
      { ...base, sourceOffset: 50, callType: "Prompt", content: "List files" },
      { ...base, sourceOffset: 0, callType: "System", content: "System instructions" },
    ], { total: 4 });
    expect(combined.events.map((event) => event.sourceOffset)).toEqual([0, 50, 100, 200]);
    const turns = buildConversationTurns(combined.events);
    expect(turns).toHaveLength(1);
    expect(turns[0].userMessages[0].content).toBe("List files");
    expect(turns[0].assistantMessages.map((entry) => entry.content)).toEqual(["Done"]);
    expect(turns[0].toolEntries).toHaveLength(1);
  });

  test("sliceConversationPage returns only the requested window", () => {
    const allEvents = Array.from({ length: CONVERSATION_PAGE_LIMIT + 25 }, (_, index) => ({
      id: index + 1,
      callType: "Agent",
      content: `event-${index + 1}`,
    }));

    const result = sliceConversationPage(allEvents, 0, CONVERSATION_PAGE_LIMIT);

    expect(result.events).toHaveLength(CONVERSATION_PAGE_LIMIT);
    expect(result.events[0].content).toBe("event-1");
    expect(result.events.at(-1).content).toBe(`event-${CONVERSATION_PAGE_LIMIT}`);
    expect(result.page).toEqual({
      total: CONVERSATION_PAGE_LIMIT + 25,
      loaded: CONVERSATION_PAGE_LIMIT,
      nextOffset: CONVERSATION_PAGE_LIMIT,
      hasMore: true,
    });
  });

  test("mergeConversationPage appends later batches and tracks total progress", () => {
    const initial = mergeConversationPage([], createEmptyConversationPage(), [
      { id: 1, content: "one" },
      { id: 2, content: "two" },
    ], { total: 5, replace: true });

    const appended = mergeConversationPage(initial.events, initial.page, [
      { id: 3, content: "three" },
      { id: 4, content: "four" },
      { id: 5, content: "five" },
    ], { total: 5 });

    expect(appended.events.map((item) => item.content)).toEqual(["one", "two", "three", "four", "five"]);
    expect(appended.page).toEqual({
      total: 5,
      loaded: 5,
      nextOffset: 5,
      hasMore: false,
    });
  });
});
