import { useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconExternalLink,
  IconRefresh,
  IconSearch,
  IconMessage2,
  IconShieldCheck,
} from "@tabler/icons-react";
import { formatDateTime, formatNumber, platformLabel } from "../lib/formatters";
import "../styles/collaboration.css";

const EMPTY_SNAPSHOT = {
  tasks: [],
  executors: [],
  policy: { maxExternalRunning: 2 },
  counts: { running: 0, awaitingReview: 0, blocked: 0, total: 0 },
};

const STATUS_META = {
  queued: { label: "排队", color: "gray" },
  running: { label: "执行中", color: "blue" },
  awaiting_review: { label: "待验收", color: "yellow" },
  passed: { label: "已通过", color: "teal" },
  partial: { label: "部分完成", color: "orange" },
  rework: { label: "返工", color: "orange" },
  blocked: { label: "阻塞", color: "red" },
  cancelled: { label: "已取消", color: "gray" },
};

const EVENT_META = {
  started: "已派发",
  returned: "执行返回",
  blocked: "已阻塞",
  reviewed: "验收完成",
  rework: "需要返工",
  cancelled: "已取消",
  session_linked: "已关联会话",
};

function statusMeta(status) {
  return STATUS_META[status] || { label: status || "未知", color: "gray" };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function taskTime(event) {
  return event?.at || event?.time || "";
}

function taskRevision(task) {
  return task ? `${task.updatedAt}:${task.status}:${task.attempt}:${task.eventCount || 0}` : "";
}

function eventText(event) {
  const payload = event?.payload || {};
  return payload.summary || payload.reason || payload.category || (payload.outcome ? `结果：${statusMeta(payload.outcome).label}` : "");
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function artifactRows(task) {
  const rows = [];
  const collect = (items, source) => {
    asArray(items).forEach((item) => {
      if (typeof item === "string") {
        rows.push({ label: item, value: item, source });
        return;
      }
      if (item && typeof item === "object") {
        const value = item.url ? safeHttpUrl(item.url) : item.path || "";
        if (value) rows.push({ label: item.label || value, value, source });
      }
    });
  };
  collect(task?.artifacts, "任务产物");
  collect(task?.evidence, "任务证据");
  asArray(task?.events).forEach((event) => {
    collect(event?.payload?.artifacts, EVENT_META[event?.type] || "事件产物");
    collect(event?.payload?.evidence, EVENT_META[event?.type] || "验收证据");
  });
  return rows.filter((row, index, all) => all.findIndex((candidate) => candidate.value === row.value && candidate.label === row.label) === index);
}

function taskTree(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const groupMap = new Map();
  tasks.forEach((task) => {
    const rootId = task.rootTaskId || task.id;
    if (!groupMap.has(rootId)) groupMap.set(rootId, []);
    groupMap.get(rootId).push(task);
  });
  return [...groupMap.entries()].map(([rootId, entries]) => {
    const ids = new Set(entries.map((task) => task.id));
    const root = byId.get(rootId) || entries.find((task) => !task.parentTaskId || !ids.has(task.parentTaskId)) || entries[0];
    const childrenByParent = new Map();
    entries.forEach((task) => {
      if (task.id === root.id) return;
      const parentId = ids.has(task.parentTaskId) ? task.parentTaskId : root.id;
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(task);
    });
    const sortRows = (rows) => rows.slice().sort((left, right) => String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || String(left.title || "").localeCompare(String(right.title || "")));
    const makeNode = (task, seen = new Set()) => ({
      task,
      children: sortRows(childrenByParent.get(task.id) || []).filter((child) => !seen.has(child.id)).map((child) => makeNode(child, new Set([...seen, task.id]))),
    });
    return makeNode(root);
  });
}

function taskMatches(task, query, status) {
  if (status && task.status !== status) return false;
  if (!query) return true;
  const haystack = [task.title, task.id, task.executor, task.modelRequested, task.modelObserved, task.cwd, task.brief].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(query.toLowerCase());
}

function TreeTask({ node, depth, selectedId, matchingIds, onSelect }) {
  const task = node.task;
  const meta = statusMeta(task.status);
  const isVisible = matchingIds.has(task.id) || node.children.some((child) => matchingIds.has(child.task.id));
  if (!isVisible) return null;
  return (
    <div className="collaboration-workspace__tree-node">
      <button
        type="button"
        className={`collaboration-workspace__task-row${selectedId === task.id ? " is-selected" : ""}`}
        style={{ "--task-depth": depth }}
        onClick={() => onSelect(task.id)}
      >
        <span className="collaboration-workspace__task-title">{task.title || task.id || "未命名任务"}</span>
        <Badge size="xs" variant="light" color={meta.color}>{meta.label}</Badge>
      </button>
      {node.children.map((child) => (
        <TreeTask key={child.task.id} node={child} depth={depth + 1} selectedId={selectedId} matchingIds={matchingIds} onSelect={onSelect} />
      ))}
    </div>
  );
}

function Value({ label, children }) {
  return <div className="collaboration-workspace__value"><span>{label}</span><strong>{children || "-"}</strong></div>;
}

function EventTimeline({ task }) {
  const events = asArray(task?.events);
  if (!events.length) return <Text className="collaboration-workspace__empty-copy">尚无任务事件。</Text>;
  return (
    <ol className="collaboration-workspace__timeline" aria-label="任务时间线">
      {events.map((event, index) => {
        const attempt = events.slice(0, index + 1).filter((item) => item.type === "started").length;
        const startedPayload = event.type === "started" ? event.payload || {} : null;
        return (
        <li key={event.id || `${event.type}-${index}`}>
          <span className={`collaboration-workspace__timeline-dot is-${event.type || "unknown"}`} aria-hidden="true" />
          <div>
            <Group gap="xs" justify="space-between" wrap="nowrap">
              <strong>{EVENT_META[event.type] || event.type || "任务事件"}{event.type === "started" ? ` · 第 ${attempt} 次尝试` : ""}</strong>
              <time>{formatDateTime(taskTime(event))}</time>
            </Group>
            {eventText(event) ? <Text>{eventText(event)}</Text> : null}
            {event?.payload?.exitCode != null ? <Text className="collaboration-workspace__event-meta">退出码：{event.payload.exitCode}</Text> : null}
            {event?.payload?.modelObserved ? <Text className="collaboration-workspace__event-meta">实际模型：{event.payload.modelObserved}</Text> : null}
            {startedPayload ? (
              <details className="collaboration-workspace__dispatch-detail">
                <summary>查看实际派发内容</summary>
                <Text className="collaboration-workspace__event-meta">实际派发简报</Text>
                <pre>{startedPayload.brief || "未记录"}</pre>
                {startedPayload.command ? <><Text className="collaboration-workspace__event-meta">命令</Text><pre>{startedPayload.command}</pre></> : null}
                {startedPayload.timeoutSeconds != null ? <Text className="collaboration-workspace__event-meta">超时：{startedPayload.timeoutSeconds} 秒</Text> : null}
              </details>
            ) : null}
          </div>
        </li>
        );
      })}
    </ol>
  );
}

function TaskDetail({ task, loading, onOpenSessionDetail }) {
  if (loading) return <div className="collaboration-workspace__detail-state"><Loader size="sm" /> 正在读取任务详情…</div>;
  if (!task) return <div className="collaboration-workspace__detail-state">从左侧选择一个任务查看派发、审核和会话证据。</div>;
  const meta = statusMeta(task.status);
  const artifacts = artifactRows(task);
  return (
    <ScrollArea className="collaboration-workspace__detail-scroll" type="auto">
      <Stack gap="lg" p="md">
        <div>
          <Group justify="space-between" align="flex-start" gap="sm">
            <div>
              <Text className="collaboration-workspace__eyebrow">任务 {task.id}</Text>
              <Title order={2}>{task.title || "未命名任务"}</Title>
            </div>
            <Badge size="lg" variant="light" color={meta.color}>{meta.label}</Badge>
          </Group>
          <Text className="collaboration-workspace__updated">更新于 {formatDateTime(task.updatedAt)}</Text>
        </div>

        <section className="collaboration-workspace__facts" aria-label="任务元数据">
          <Value label="执行器">{platformLabel(task.executor)}</Value>
          <Value label="尝试次数">{task.attempt ? `第 ${task.attempt} 次` : "-"}</Value>
          <Value label="请求模型">{task.modelRequested}</Value>
          <Value label="实际模型">{task.modelObserved || "尚未观察到"}</Value>
          <Value label="创建时间">{formatDateTime(task.createdAt)}</Value>
          <Value label="权限">{task.permission}</Value>
        </section>

        <section>
          <Text className="collaboration-workspace__section-label">任务简报</Text>
          <pre className="collaboration-workspace__pre">{task.brief || "未提供简报。"}</pre>
        </section>
        <section>
          <Text className="collaboration-workspace__section-label">工作范围</Text>
          <div className="collaboration-workspace__scope"><span>工作目录</span><code>{task.cwd || "未记录"}</code></div>
          <div className="collaboration-workspace__scope"><span>可写路径</span><code>{asArray(task.writePaths).join("\n") || "未记录"}</code></div>
        </section>

        <section>
          <Text className="collaboration-workspace__section-label">关联会话</Text>
          {asArray(task.sessions).length ? <div className="collaboration-workspace__sessions">{task.sessions.map((session) => (
            <Button
              key={`${session.provider}-${session.sessionId}`}
              variant="light"
              size="xs"
              leftSection={<IconMessage2 size={14} />}
              onClick={() => onOpenSessionDetail?.({ sessionId: session.sessionId, sourceType: session.provider, sessionTitle: task.title })}
            >
              {platformLabel(session.provider)} · {session.sessionId}
            </Button>
          ))}</div> : <Text className="collaboration-workspace__empty-copy">没有已确认的会话关联。</Text>}
        </section>

        <section>
          <Text className="collaboration-workspace__section-label">产物与验收证据</Text>
          {artifacts.length ? <div className="collaboration-workspace__artifacts">{artifacts.map((artifact, index) => {
            const url = safeHttpUrl(artifact.value);
            return <div key={`${artifact.value}-${index}`}><span>{artifact.source}</span>{url ? <a href={url} target="_blank" rel="noreferrer"><IconExternalLink size={13} /> {artifact.label}</a> : <code>{artifact.value}</code>}</div>;
          })}</div> : <Text className="collaboration-workspace__empty-copy">尚未记录产物或审核证据。</Text>}
        </section>

        <section>
          <Text className="collaboration-workspace__section-label">派发与验收时间线</Text>
          <EventTimeline task={task} />
        </section>
      </Stack>
    </ScrollArea>
  );
}

function ExecutorPanel({ snapshot }) {
  const executors = asArray(snapshot.executors);
  const runningTasks = asArray(snapshot.tasks).filter((task) => task.status === "running");
  const externalRunning = runningTasks.filter((task) => task.executor !== "codex");
  const maxRunning = Number(snapshot.policy?.maxExternalRunning || 2);
  return (
    <Paper withBorder p="md" radius="md" className="collaboration-workspace__executor-panel">
      <Group justify="space-between" align="flex-start">
        <div><Text className="collaboration-workspace__eyebrow">执行边界</Text><Title order={3}>外部并发与健康快照</Title></div>
        <Badge variant="light" color={externalRunning.length >= maxRunning ? "orange" : "teal"}>{externalRunning.length} / {maxRunning} 外部</Badge>
      </Group>
      <Text className="collaboration-workspace__health-note"><IconShieldCheck size={14} /> 以下是最近检查记录，不代表会自动判定当前可用。</Text>
      <div className="collaboration-workspace__executor-list">
        {executors.length ? executors.map((executor) => (
          <div key={executor.executor}>
            <strong>{platformLabel(executor.executor)}</strong>
            <span>最近状态：{{ available: "可用", blocked: "阻塞", unknown: "未知" }[executor.status] || "未知"}{executor.category ? ` · ${executor.category}` : ""}</span>
            <span>{executor.summary || executor.category || "暂无检查摘要"}</span>
            <time>{formatDateTime(executor.checkedAt)}</time>
          </div>
        )) : <Text className="collaboration-workspace__empty-copy">暂无执行器健康快照。</Text>}
      </div>
      <Text className="collaboration-workspace__section-label">执行中的写入声明</Text>
      {runningTasks.length ? <div className="collaboration-workspace__claims">{runningTasks.map((task) => <div key={task.id}><strong>{task.title || task.id}</strong><code>{asArray(task.writePaths).join("\n") || "未声明可写路径"}</code></div>)}</div> : <Text className="collaboration-workspace__empty-copy">当前没有执行中的写入声明。</Text>}
    </Paper>
  );
}

export function CollaborationWorkspace({ onOpenSessionDetail, refreshToken }) {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selectedTask, setSelectedTask] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const overviewAbortRef = useRef(null);
  const detailAbortRef = useRef(null);
  const detailRequestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const selectedIdRef = useRef("");
  const selectedOverviewUpdatedRef = useRef("");
  const overviewTasksRef = useRef([]);
  const [detailRevision, setDetailRevision] = useState(0);
  const seenRefreshTokenRef = useRef(refreshToken);

  const loadOverview = async ({ initial = false } = {}) => {
    overviewAbortRef.current?.abort();
    const controller = new AbortController();
    overviewAbortRef.current = controller;
    if (initial) setLoading(true);
    try {
      const response = await fetch("/api/collaboration", { signal: controller.signal });
      if (!response.ok) throw new Error(`请求失败（${response.status}）`);
      const payload = await response.json();
      if (!mountedRef.current || controller.signal.aborted) return;
      const nextTasks = asArray(payload.tasks);
      overviewTasksRef.current = nextTasks;
      setSnapshot({ ...EMPTY_SNAPSHOT, ...payload, tasks: nextTasks, executors: asArray(payload.executors) });
      const selectedOverview = nextTasks.find((task) => task.id === selectedIdRef.current);
      if (selectedOverview && taskRevision(selectedOverview) !== selectedOverviewUpdatedRef.current) {
        setDetailRevision((revision) => revision + 1);
      }
      setError("");
    } catch (requestError) {
      if (requestError?.name !== "AbortError" && mountedRef.current) setError(requestError?.message || "无法读取协作数据。");
    } finally {
      if (mountedRef.current && initial) setLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    loadOverview({ initial: true });
    const timer = window.setInterval(() => loadOverview(), 10_000);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      overviewAbortRef.current?.abort();
      detailAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (refreshToken == null || refreshToken === seenRefreshTokenRef.current) return;
    seenRefreshTokenRef.current = refreshToken;
    loadOverview();
  }, [refreshToken]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    selectedOverviewUpdatedRef.current = "";
    setSelectedTask(null);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return undefined;
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    const requestedRevision = taskRevision(overviewTasksRef.current.find((task) => task.id === selectedId));
    setDetailLoading(true);
    fetch(`/api/collaboration/tasks/${encodeURIComponent(selectedId)}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`任务详情请求失败（${response.status}）`);
        return response.json();
      })
      .then((payload) => {
        if (mountedRef.current && !controller.signal.aborted && requestId === detailRequestIdRef.current) {
          setSelectedTask(payload.task || null);
          selectedOverviewUpdatedRef.current = requestedRevision;
        }
      })
      .catch((requestError) => {
        if (requestError?.name !== "AbortError" && mountedRef.current && requestId === detailRequestIdRef.current) {
          setError(requestError?.message || "无法读取任务详情。");
          setSelectedTask(null);
          selectedOverviewUpdatedRef.current = "";
        }
      })
      .finally(() => {
        if (mountedRef.current && requestId === detailRequestIdRef.current) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedId, detailRevision]);

  const trees = useMemo(() => taskTree(snapshot.tasks), [snapshot.tasks]);
  const matchingIds = useMemo(() => {
    const direct = new Set(snapshot.tasks.filter((task) => taskMatches(task, query.trim(), status)).map((task) => task.id));
    const byId = new Map(snapshot.tasks.map((task) => [task.id, task]));
    [...direct].forEach((id) => {
      let current = byId.get(id);
      const seen = new Set();
      while (current?.parentTaskId && !seen.has(current.parentTaskId)) {
        seen.add(current.parentTaskId);
        direct.add(current.parentTaskId);
        current = byId.get(current.parentTaskId);
      }
    });
    return direct;
  }, [snapshot.tasks, query, status]);
  const counts = { ...EMPTY_SNAPSHOT.counts, ...snapshot.counts };

  return (
    <div className="collaboration-workspace">
      <div className="collaboration-workspace__header">
        <div><Text className="collaboration-workspace__eyebrow">协作观察</Text><Title order={2}>任务派发与审核</Title><Text>只读展示派发边界、返回结果和会话证据。</Text></div>
        <Button variant="light" leftSection={<IconRefresh size={15} />} onClick={() => loadOverview()} loading={loading}>刷新</Button>
      </div>
      <Text size="xs" c="dimmed">仅显示已登记的调用；写入范围是协同声明，实际权限由执行环境控制。</Text>
      <div className="collaboration-workspace__metrics">
        <div><IconClock size={17} /><strong>{formatNumber(counts.running)}</strong><span>执行中</span></div>
        <div><IconShieldCheck size={17} /><strong>{formatNumber(counts.awaitingReview)}</strong><span>待验收</span></div>
        <div><IconAlertTriangle size={17} /><strong>{formatNumber(counts.blocked)}</strong><span>阻塞</span></div>
        <div><IconCheck size={17} /><strong>{formatNumber(counts.total)}</strong><span>全部任务</span></div>
      </div>
      {error ? <Paper withBorder p="sm" className="collaboration-workspace__error">{error}</Paper> : null}
      <div className="collaboration-workspace__layout">
        <Paper withBorder radius="md" className="collaboration-workspace__task-panel">
          <div className="collaboration-workspace__filters">
            <TextInput value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索任务、模型或路径" leftSection={<IconSearch size={15} />} aria-label="搜索任务" />
            <Select value={status} onChange={(value) => setStatus(value || "")} data={[{ value: "", label: "全部状态" }, ...Object.entries(STATUS_META).map(([value, meta]) => ({ value, label: meta.label }))]} aria-label="按状态筛选" />
          </div>
          {loading ? <div className="collaboration-workspace__panel-state"><Loader size="sm" /> 正在加载任务…</div> : null}
          {!loading && !snapshot.tasks.length ? <div className="collaboration-workspace__panel-state">暂无协作任务。</div> : null}
          {!loading && snapshot.tasks.length && !matchingIds.size ? <div className="collaboration-workspace__panel-state">没有匹配的任务。</div> : null}
          <ScrollArea className="collaboration-workspace__tree-scroll" type="auto">
            {trees.map((tree) => <TreeTask key={tree.task.id} node={tree} depth={0} selectedId={selectedId} matchingIds={matchingIds} onSelect={setSelectedId} />)}
          </ScrollArea>
        </Paper>
        <Paper withBorder radius="md" className="collaboration-workspace__detail-panel"><TaskDetail task={selectedTask?.id === selectedId ? selectedTask : null} loading={detailLoading} onOpenSessionDetail={onOpenSessionDetail} /></Paper>
        <ExecutorPanel snapshot={snapshot} />
      </div>
    </div>
  );
}
