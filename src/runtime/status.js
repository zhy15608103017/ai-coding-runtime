export const RUN_STATUS = {
  planned: "planned",
  approvalRequired: "approval_required",
  approved: "approved",
  verifying: "verifying",
  verificationPassed: "verification_passed",
  verificationFailed: "verification_failed",
  verificationSkipped: "verification_skipped",
  canceled: "canceled",
};

export const OUTCOME_EXCLUDED_STATUSES = new Set([
  RUN_STATUS.planned,
  RUN_STATUS.approvalRequired,
  "approval-pending",
  "approval_pending",
  RUN_STATUS.approved,
  RUN_STATUS.verifying,
  RUN_STATUS.canceled,
  "verification-skipped",
  RUN_STATUS.verificationSkipped,
  "approval-rejected",
  "approval_rejected",
]);

export function isOutcomeExcludedStatus(status) {
  return OUTCOME_EXCLUDED_STATUSES.has(status);
}

export function canVerifyRun(status) {
  return [
    RUN_STATUS.planned,
    RUN_STATUS.approved,
    RUN_STATUS.verificationFailed,
  ].includes(status);
}
