export { MetricsStore } from "./store.js";
export { buildCalibrationReport, collectSamples, fmtPct } from "./calibration.js";
export type {
  CalibrationReport,
  CalibrationBucket,
  ConfidenceSample,
  FalseConfidenceEntry,
  MetricCalibrationStats
} from "./calibration.js";
export { buildMetricsReport, buildTimeSeries, renderMarkdownReport } from "./report.js";
export type { MetricsReport, TrendRow } from "./report.js";
export { main as cliMain } from "./cli.js";
export * from "./types.js";