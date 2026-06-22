export function reviewTaskAcceptance({ tasks = [], workerAttempts = [] } = {}) {
  const hasWorkerAttempts = workerAttempts.length > 0;
  const taskReviews = tasks.map((task) => reviewTask({ task, workerAttempts, hasWorkerAttempts }));
  const status = summarizeAcceptanceStatus(taskReviews);

  return {
    name: "task-acceptance",
    status,
    tasks: taskReviews,
  };
}

function reviewTask({ task = {}, workerAttempts = [], hasWorkerAttempts = false } = {}) {
  const taskId = task.task_id ?? task.id;
  const latestAttempt = [...workerAttempts]
    .reverse()
    .find((attempt) => (attempt.task_id ?? attempt.taskId) === taskId);
  const criteria = Array.isArray(task.acceptance) ? task.acceptance : [];
  const items = criteria.map((criterion) =>
    reviewCriterion({ criterion, latestAttempt, hasWorkerAttempts })
  );
  const status = latestAttempt
    ? summarizeItemStatus(items)
    : hasWorkerAttempts
      ? "failed"
      : "skipped";

  return {
    taskId,
    task_id: taskId,
    title: task.title,
    status,
    attemptId: latestAttempt?.attempt_id ?? latestAttempt?.attemptId ?? null,
    attempt_id: latestAttempt?.attempt_id ?? latestAttempt?.attemptId ?? null,
    items,
  };
}

function reviewCriterion({ criterion, latestAttempt, hasWorkerAttempts }) {
  if (!latestAttempt) {
    return {
      criterion,
      status: hasWorkerAttempts ? "failed" : "skipped",
      evidence: "",
    };
  }

  const evidence = latestAttempt.acceptance?.[criterion];
  const passed = typeof evidence === "string" && evidence.trim().length > 0;

  return {
    criterion,
    status: passed ? "passed" : "failed",
    evidence: typeof evidence === "string" ? evidence : "",
  };
}

function summarizeItemStatus(items) {
  if (items.length === 0) return "skipped";
  return items.every((item) => item.status === "passed") ? "passed" : "failed";
}

function summarizeAcceptanceStatus(taskReviews) {
  if (taskReviews.length === 0) return "skipped";
  if (taskReviews.some((review) => review.status === "failed")) return "failed";
  if (taskReviews.every((review) => review.status === "skipped")) return "skipped";
  return "passed";
}
