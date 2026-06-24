export function createLearningProfile() {
  return {
    enabled: true,
    mode: "shadow",
    recordsScanned: 0,
    records_scanned: 0,
    eligibleSamples: 0,
    eligible_samples: 0,
    ignoredRecords: 0,
    ignored_records: 0,
    samples: [],
    buckets: [],
    recommendations: [],
  };
}
