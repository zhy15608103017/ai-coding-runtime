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

export function canVerifyRun(status) {
  return [
    RUN_STATUS.planned,
    RUN_STATUS.approved,
    RUN_STATUS.verificationFailed,
  ].includes(status);
}
