export function createDashboardHtml(report, { generatedAt = new Date().toISOString() } = {}) {
  const model = createDashboardModel(report);
  const title = "AI Coding Runtime Dashboard";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - ${escapeHtml(model.runId)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #16201c;
      --muted: #66736c;
      --paper: #f7f3ea;
      --panel: #fffdf8;
      --line: #d8d0c1;
      --coal: #1f2933;
      --green: #197b55;
      --amber: #b66a18;
      --red: #b43b3b;
      --blue: #245f9e;
      --violet: #7253a4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: "Aptos", "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    header {
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(90deg, rgba(25,123,85,.10), rgba(36,95,158,.08) 46%, rgba(182,106,24,.10)),
        var(--panel);
    }
    .wrap { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; }
    .hero { padding: 28px 0 22px; display: grid; gap: 18px; }
    h1, h2, h3 { margin: 0; line-height: 1.15; letter-spacing: 0; }
    h1 { font-family: Georgia, "Times New Roman", serif; font-size: 34px; font-weight: 700; }
    h2 { font-size: 18px; }
    h3 { font-size: 14px; color: var(--muted); text-transform: uppercase; }
    .subtle { color: var(--muted); }
    .mono { font-family: "Cascadia Mono", "SFMono-Regular", Consolas, monospace; }
    .topline { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 3px 9px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,.7);
      font-size: 12px;
      font-weight: 650;
    }
    .badge.ok { border-color: rgba(25,123,85,.35); color: var(--green); }
    .badge.warn { border-color: rgba(182,106,24,.35); color: var(--amber); }
    .badge.fail { border-color: rgba(180,59,59,.35); color: var(--red); }
    .grid { display: grid; gap: 14px; }
    .summary { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .main { grid-template-columns: 1.2fr .8fr; margin: 18px 0 28px; align-items: start; }
    section, .metric {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(31,41,51,.06);
    }
    section { padding: 16px; }
    .metric { padding: 13px 14px; }
    .metric strong { display: block; font-size: 22px; margin-top: 4px; }
    .section-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 12px; }
    .task-list, .timeline, .model-list, .shadow-list { display: grid; gap: 10px; }
    .task {
      display: grid;
      grid-template-columns: minmax(72px, 110px) minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      padding: 12px;
      border: 1px solid #e6ded0;
      border-radius: 6px;
      background: #fffaf0;
    }
    .task-title { font-weight: 700; overflow-wrap: anywhere; }
    .task-meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 7px; }
    .route { border-left: 4px solid var(--blue); padding-left: 10px; }
    .route.shadow { border-color: var(--green); }
    .row { display: flex; justify-content: space-between; gap: 14px; padding: 8px 0; border-bottom: 1px solid #ece4d6; }
    .row:last-child { border-bottom: 0; }
    .timeline-item {
      display: grid;
      grid-template-columns: 12px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
    }
    .dot { width: 10px; height: 10px; margin-top: 6px; border-radius: 50%; background: var(--blue); }
    .dot.ok { background: var(--green); }
    .dot.fail { background: var(--red); }
    .empty { color: var(--muted); font-style: italic; }
    footer { color: var(--muted); font-size: 12px; padding: 0 0 28px; }
    @media (max-width: 860px) {
      .summary, .main { grid-template-columns: 1fr; }
      .task { grid-template-columns: 1fr; }
      h1 { font-size: 28px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap hero">
      <div class="topline">
        <span class="${statusClass(model.status)}">${escapeHtml(model.status)}</span>
        <span class="badge">${escapeHtml(model.verificationStatus)}</span>
        <span class="badge">${escapeHtml(model.approvalStatus)}</span>
      </div>
      <div>
        <h1>${escapeHtml(title)}</h1>
        <div class="subtle mono">${escapeHtml(model.runId)}</div>
      </div>
      <div>${escapeHtml(model.request)}</div>
    </div>
  </header>
  <main class="wrap">
    <div class="grid summary">
      ${metric("Tasks", model.taskCount)}
      ${metric("Visible Cost", `${model.currency} ${model.totalVisibleCost}`)}
      ${metric("Model Calls", model.modelCallCount)}
      ${metric("Shadow Savings", `${model.currency} ${model.shadowPotentialSavings}`)}
    </div>
    <div class="grid main">
      <section>
        <div class="section-head">
          <h2>Task Graph</h2>
          <span class="subtle">${escapeHtml(model.taskCount)} task(s)</span>
        </div>
        <div class="task-list">
          ${model.tasks.length ? model.tasks.map(formatTask).join("") : `<p class="empty">No tasks recorded.</p>`}
        </div>
      </section>
      <div class="grid">
        <section>
          <div class="section-head"><h2>Verification Timeline</h2></div>
          <div class="timeline">
            ${model.timeline.length ? model.timeline.map(formatTimelineItem).join("") : `<p class="empty">No verification evidence recorded.</p>`}
          </div>
        </section>
        <section>
          <div class="section-head"><h2>Cost Breakdown</h2></div>
          ${row("Planned routing", `${model.currency} ${model.plannedRoutingCost}`)}
          ${row("Provider", `${model.currency} ${model.providerCost}`)}
          ${row("Unattributed provider", `${model.currency} ${model.unattributedProviderCost}`)}
          ${row("Total visible", `${model.currency} ${model.totalVisibleCost}`)}
        </section>
      </div>
      <section>
        <div class="section-head"><h2>Shadow Classifier</h2><span class="subtle">${escapeHtml(model.shadowStatus)}</span></div>
        ${row("Provider/model", model.shadowProviderModel)}
        <div class="shadow-list">
          ${model.shadowRecommendations.length ? model.shadowRecommendations.map(formatShadow).join("") : `<p class="empty">No shadow recommendations recorded.</p>`}
        </div>
      </section>
      <section>
        <div class="section-head"><h2>Model Performance</h2></div>
        <div class="model-list">
          ${model.modelPerformance.length ? model.modelPerformance.map(formatModelPerformance).join("") : `<p class="empty">No model reliability samples recorded yet.</p>`}
        </div>
      </section>
    </div>
  </main>
  <footer class="wrap">Generated ${escapeHtml(generatedAt)} from report data. Static read-only dashboard.</footer>
</body>
</html>
`;
}

export function createDashboardModel(report) {
  const cost = report.costReport?.summary ?? {};
  const shadow = report.shadowClassifier ?? report.shadow_classifier ?? {};
  const shadowSummary = shadow.summary ?? {};
  const verification = report.verificationSummary ?? {};
  const tasks = Array.isArray(report.taskGraph) ? report.taskGraph : [];
  const routing = new Map((report.routingDecisions ?? []).map((item) => [item.taskId, item]));
  const shadowByTask = new Map(
    (shadow.recommendations ?? []).map((item) => [item.taskId ?? item.task_id, item])
  );

  return {
    runId: report.runId ?? "unknown-run",
    status: report.status ?? "unknown",
    request: report.request ?? "",
    taskCount: tasks.length,
    approvalStatus: report.approval?.status ?? "approval unknown",
    verificationStatus: verification.latestStatus ?? "verification skipped",
    currency: cost.currency ?? report.modelUsage?.currency ?? "USD",
    plannedRoutingCost: numberOrZero(cost.plannedRoutingCost),
    providerCost: numberOrZero(cost.providerCost),
    unattributedProviderCost: numberOrZero(cost.unattributedProviderCost),
    totalVisibleCost: numberOrZero(cost.totalVisibleCost),
    modelCallCount: report.modelUsage?.callCount ?? 0,
    shadowStatus: shadow.status ?? "unavailable",
    shadowProviderModel: [shadow.provider, shadow.model].filter(Boolean).join("/") || "not configured",
    shadowPotentialSavings: numberOrZero(shadowSummary.potentialSavingsUsd ?? shadowSummary.potential_savings_usd),
    tasks: tasks.map((task) => {
      const taskId = task.taskId ?? task.task_id ?? task.id ?? "unknown-task";
      const route = routing.get(taskId) ?? {};
      const shadowRecommendation = shadowByTask.get(taskId) ?? {};
      return {
        taskId,
        title: task.title ?? task.description ?? taskId,
        status: task.status ?? "planned",
        modelTier: task.modelTier ?? task.model_tier ?? route.modelTier ?? "unknown",
        selectedModel: formatSelectedModel(route.selectedModel ?? task.selectedModel ?? task.selected_model),
        reason: route.reason ?? task.routingReason ?? task.routing_reason ?? "No routing reason recorded.",
        shadowTier:
          shadowRecommendation.recommendedTier ??
          shadowRecommendation.recommended_tier ??
          shadowRecommendation.suggestedTier ??
          shadowRecommendation.suggested_tier ??
          null,
        shadowCategory: shadowRecommendation.category ?? null,
        shadowConfidence: shadowRecommendation.confidence ?? null,
      };
    }),
    timeline: createTimeline(report),
    shadowRecommendations: shadow.recommendations ?? [],
    modelPerformance: report.modelReliability?.samples ?? [],
  };
}

function createTimeline(report) {
  const latest = Array.isArray(report.verification) ? report.verification.at(-1) : null;
  if (!latest) return [];
  const commands = Array.isArray(latest.commands) ? latest.commands : [];
  return [
    { label: "Verification", status: latest.status ?? "unknown" },
    ...commands.map((command) => ({
      label: command.name ?? command.command ?? "command",
      status: command.status ?? (command.exitCode === 0 ? "passed" : "failed"),
    })),
    { label: "Acceptance review", status: latest.acceptance?.status ?? "skipped" },
    {
      label: "Final supervisor review",
      status: latest.supervisorReview?.status ?? latest.supervisor_review?.status ?? "skipped",
    },
  ];
}

function metric(label, value) {
  return `<div class="metric"><span class="subtle">${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function row(label, value) {
  return `<div class="row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function formatTask(task) {
  return `<article class="task">
    <div class="mono">${escapeHtml(task.taskId)}</div>
    <div>
      <div class="task-title">${escapeHtml(task.title)}</div>
      <div class="task-meta">
        <span class="badge">${escapeHtml(task.status)}</span>
        <span class="badge">${escapeHtml(task.modelTier)}</span>
        ${task.shadowTier ? `<span class="badge ok">shadow: ${escapeHtml(task.shadowTier)}</span>` : ""}
      </div>
    </div>
    <div>
      <div class="route"><strong>Route</strong><br>${escapeHtml(task.selectedModel)}<br><span class="subtle">${escapeHtml(task.reason)}</span></div>
      ${
        task.shadowTier
          ? `<div class="route shadow" style="margin-top:10px"><strong>Shadow</strong><br>${escapeHtml(task.shadowTier)} ${formatConfidence(task.shadowConfidence)}<br><span class="subtle">${escapeHtml(task.shadowCategory ?? "recommendation")}</span></div>`
          : ""
      }
    </div>
  </article>`;
}

function formatTimelineItem(item) {
  const cls = item.status === "passed" || item.status === "skipped" ? "ok" : item.status === "failed" ? "fail" : "";
  return `<div class="timeline-item"><span class="dot ${cls}"></span><div>${escapeHtml(item.label)}<br><span class="subtle">${escapeHtml(item.status)}</span></div></div>`;
}

function formatShadow(item) {
  const taskId = item.taskId ?? item.task_id ?? "unknown-task";
  const tier = item.recommendedTier ?? item.recommended_tier ?? item.suggestedTier ?? item.suggested_tier ?? "unknown";
  const category = item.category ?? "recommendation";
  const savings = item.estimatedSavingsUsd ?? item.estimated_savings_usd ?? item.potentialSavingsUsd ?? item.potential_savings_usd;
  return `<div class="row"><span><span class="mono">${escapeHtml(taskId)}</span> ${escapeHtml(category)} to ${escapeHtml(tier)} ${formatConfidence(item.confidence)}</span><strong>${savings === undefined ? "" : `potential savings ${escapeHtml(String(savings))}`}</strong></div>`;
}

function formatModelPerformance(item) {
  const label = `${item.taskType ?? item.task_type ?? "unknown"} / ${item.modelTier ?? item.model_tier ?? "unknown"}`;
  const attempts = item.attempts ?? 0;
  const rate = item.successRate ?? item.success_rate ?? 0;
  return `<div class="row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(attempts))} sample(s), ${escapeHtml(String(rate))} success</strong></div>`;
}

function formatConfidence(confidence) {
  return Number.isFinite(confidence) ? `(${Math.round(confidence * 100)}%)` : "";
}

function formatSelectedModel(model) {
  if (!model) return "model not recorded";
  if (typeof model === "string") return model;
  return [model.provider, model.model].filter(Boolean).join("/") || "model not recorded";
}

function statusClass(status) {
  if (/passed|completed|approved/.test(status)) return "badge ok";
  if (/failed|rejected|blocked/.test(status)) return "badge fail";
  return "badge warn";
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
