import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CollaborationWorkspace } from "../collaboration-workspace";

const task = {
  id: "task-root",
  rootTaskId: "task-root",
  title: "完成协作面板",
  executor: "claude",
  modelRequested: "claude-sonnet",
  modelObserved: "claude-sonnet-4-6",
  brief: "只修改允许的组件文件。",
  cwd: "/work/session-observer",
  writePaths: ["src/components/collaboration-workspace.jsx"],
  permission: "read-write scoped",
  status: "awaiting_review",
  attempt: 1,
  createdAt: "2026-09-11T08:00:00.000Z",
  updatedAt: "2026-09-11T08:05:00.000Z",
  sessions: [{ provider: "claude", sessionId: "claude-session-1" }],
};

const child = {
  ...task,
  id: "task-child",
  parentTaskId: "task-root",
  rootTaskId: "task-root",
  title: "验证详情",
  status: "blocked",
};

function snapshot(tasks = [task, child]) {
  return {
    tasks,
    executors: [{ executor: "claude", status: "available", summary: "上次检查通过", checkedAt: "2026-09-11T08:04:00.000Z" }],
    policy: { maxExternalRunning: 2 },
    counts: { running: 1, awaitingReview: 1, blocked: 1, total: tasks.length },
  };
}

function detail(overrides = {}) {
  return {
    task: {
      ...task,
      events: [
        { id: "start", type: "started", at: "2026-09-11T08:00:00.000Z", payload: { brief: "只修改允许的组件文件。" } },
        { id: "return", type: "returned", at: "2026-09-11T08:03:00.000Z", payload: { summary: "实现完成", exitCode: 0, artifacts: [{ label: "报告", url: "https://example.test/report" }, { label: "本地日志", path: "/private/log.txt" }, { label: "不安全链接", url: "javascript:alert(1)" }] } },
        { id: "review", type: "reviewed", at: "2026-09-11T08:04:00.000Z", payload: { outcome: "passed", summary: "审核通过", evidence: [{ label: "证据", url: "https://example.test/evidence" }] } },
      ],
      ...overrides,
    },
  };
}

function response(body, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
}

function renderWorkspace(props = {}) {
  return render(<MantineProvider><CollaborationWorkspace {...props} /></MantineProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CollaborationWorkspace", () => {
  test("shows loading then a grouped hierarchy and preserves the selected detail on refresh", async () => {
    let resolveOverview;
    const firstOverview = new Promise((resolve) => { resolveOverview = resolve; });
    const fetchMock = vi.fn((url) => {
      if (url === "/api/collaboration") return firstOverview;
      if (url === "/api/collaboration/tasks/task-root") return response(detail());
      return response(snapshot());
    });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = renderWorkspace({ refreshToken: 0 });
    expect(screen.getByText("正在加载任务…")).toBeInTheDocument();
    resolveOverview(await response(snapshot()));
    expect(await screen.findByText("完成协作面板")).toBeInTheDocument();
    expect(screen.getByText("验证详情")).toBeInTheDocument();

    fireEvent.click(screen.getByText("完成协作面板"));
    expect(await screen.findByText("派发与验收时间线")).toBeInTheDocument();
    rerender(<MantineProvider><CollaborationWorkspace refreshToken={1} /></MantineProvider>);
    expect(screen.getByText("派发与验收时间线")).toBeInTheDocument();
  });

  test("renders detail evidence safely and navigates only an explicit linked session", async () => {
    const onOpenSessionDetail = vi.fn();
    vi.stubGlobal("fetch", vi.fn((url) => {
      if (url === "/api/collaboration") return response(snapshot());
      return response(detail());
    }));
    renderWorkspace({ onOpenSessionDetail });
    fireEvent.click(await screen.findByText("完成协作面板"));
    expect(await screen.findByText("审核通过")).toBeInTheDocument();
    expect(screen.getByText("实际模型")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /报告/ })).toHaveAttribute("href", "https://example.test/report");
    expect(screen.queryByText("不安全链接")).not.toBeInTheDocument();
    expect(screen.getByText("/private/log.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByText("查看实际派发内容"));
    expect(screen.getAllByText("只修改允许的组件文件。")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /Claude Code.*claude-session-1/ }));
    expect(onOpenSessionDetail).toHaveBeenCalledWith({ sessionId: "claude-session-1", sourceType: "claude", sessionTitle: "完成协作面板" });
  });

  test("shows empty data and a readable request error without retry controls", async () => {
    vi.stubGlobal("fetch", vi.fn(() => response({ message: "failed" }, false)));
    renderWorkspace();
    expect(await screen.findByText("请求失败（500）")).toBeInTheDocument();
    expect(screen.getByText("暂无协作任务。")).toBeInTheDocument();
    expect(screen.queryByText("执行任务")).not.toBeInTheDocument();
  });

  test("filters the hierarchy by task search", async () => {
    vi.stubGlobal("fetch", vi.fn((url) => response(url === "/api/collaboration" ? snapshot() : detail())));
    renderWorkspace();
    await screen.findByText("验证详情");
    fireEvent.change(screen.getByLabelText("搜索任务"), { target: { value: "验证详情" } });
    expect(screen.getByText("验证详情")).toBeInTheDocument();
    expect(screen.getByText("完成协作面板")).toBeInTheDocument();
  });

  test("reloads a selected task detail when the overview reports a newer update", async () => {
    const first = { ...task, status: "running", updatedAt: "2026-09-11T08:05:00.000Z" };
    const later = { ...task, status: "passed", updatedAt: "2026-09-11T08:12:00.000Z" };
    let overviewCalls = 0;
    let detailCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url) => {
      if (url === "/api/collaboration") {
        overviewCalls += 1;
        return response(snapshot([overviewCalls === 1 ? first : later]));
      }
      detailCalls += 1;
      return response(detail(detailCalls === 1
        ? { ...first, events: [{ id: "start", type: "started", at: "2026-09-11T08:00:00.000Z", payload: { brief: "实际发送的第一版简报", command: "npm test", timeoutSeconds: 30 } }] }
        : { ...later, events: [{ id: "review", type: "reviewed", at: "2026-09-11T08:12:00.000Z", payload: { outcome: "passed", summary: "新验收结果" } }] }));
    }));
    const { rerender } = renderWorkspace({ refreshToken: 0 });
    fireEvent.click(await screen.findByRole("button", { name: /完成协作面板/ }));
    expect(await screen.findByText("查看实际派发内容")).toBeInTheDocument();
    fireEvent.click(screen.getByText("查看实际派发内容"));
    expect(screen.getByText("实际发送的第一版简报")).toBeInTheDocument();

    rerender(<MantineProvider><CollaborationWorkspace refreshToken={1} /></MantineProvider>);
    expect(await screen.findByText("新验收结果")).toBeInTheDocument();
    expect(screen.getAllByText("已通过").length).toBeGreaterThan(0);
    expect(detailCalls).toBe(2);
  });

  test("failed selection never displays another task and the same revision can be retried", async () => {
    let childRequests = 0;
    vi.stubGlobal("fetch", vi.fn((url) => {
      if (url === "/api/collaboration") return response(snapshot());
      if (url.endsWith(child.id)) {
        childRequests += 1;
        return childRequests === 1 ? response({}, false) : response(detail({ ...child, brief: "正确子任务简报" }));
      }
      return response(detail({ brief: "仅属于父任务的简报" }));
    }));
    const { rerender } = renderWorkspace({ refreshToken: 0 });
    fireEvent.click(await screen.findByRole("button", { name: /完成协作面板/ }));
    expect(await screen.findByText("仅属于父任务的简报")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /验证详情/ }));
    expect(await screen.findByText("任务详情请求失败（500）")).toBeInTheDocument();
    expect(screen.queryByText("仅属于父任务的简报")).not.toBeInTheDocument();
    rerender(<MantineProvider><CollaborationWorkspace refreshToken={1} /></MantineProvider>);
    expect(await screen.findByText("正确子任务简报")).toBeInTheDocument();
    expect(childRequests).toBe(2);
  });
});
