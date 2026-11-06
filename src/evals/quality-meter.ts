/**
 * Why this file exists: answer quality can slip without any error showing. This file
 * tracks six quality numbers over recent requests and raises an alert when one
 * crosses its limit. Without it, a bad model change or a weak index would only be
 * noticed when customers complained.
 */
/**
 * The limit for each quality number.
 * A "floor" alert fires when the average falls below it. A "ceiling" alert fires when
 * the average rises above it.
 * The prompt guard block rate has a ceiling, because a high rate is the bad direction.
 */
export const METRIC_LIMITS = {
  responseConfidence: { floor: 0.72 },
  citationPassRate: { floor: 0.85 },
  promptGuardBlockRate: { ceiling: 0.25 },
  retrievalMatchStrength: { floor: 0.55 },
  schemaValidationRate: { floor: 0.95 },
  llmJudgeScore: { floor: 0.75 },
} as const;

/** The name of one tracked quality number. */
export type Metric = keyof typeof METRIC_LIMITS;

/**
 * One reading taken after a request. `at` is a time in milliseconds since 1970.
 * Any metric may be missing from a reading.
 */
export type QualitySample = { at: number } & Partial<Record<Metric, number>>;

/**
 * Keeps recent quality readings and works out which alerts are active.
 * The readings live in this instance. The module exports one shared instance.
 */
export class QualityMeter {
  /** Readings in time order. Trimmed to the time window and the newest 300. */
  points: QualitySample[] = [];

  /** Metrics whose alert is on now. */
  private active = new Set<Metric>();

  /** Metrics that had an alert and are back inside their limit. */
  private recovered = new Set<Metric>();

  /** How many of the newest readings are averaged for each metric. */
  public sampleWindow: number;

  /** Readings older than this many milliseconds are ignored. */
  public timeWindowMs: number;

  /** Clock for the meter. A test can pass a fixed clock. */
  private now: () => number;

  /** Creates a meter. Defaults: average the newest 8 readings, keep one hour. */
  constructor({
    sampleWindow = 8,
    timeWindowMs = 3600000,
    now = () => Date.now(),
  }: { sampleWindow?: number; timeWindowMs?: number; now?: () => number } = {}) {
    this.sampleWindow = sampleWindow;
    this.timeWindowMs = timeWindowMs;
    this.now = now;
  }

  /**
   * Adds one reading and returns the new status.
   * If `sample.at` is missing: uses the current time.
   * Drops readings older than the time window and keeps at most the newest 300.
   */
  record({ sample }: { sample: Omit<QualitySample, 'at'> & { at?: number } }) {
    this.points.push({ ...sample, at: sample.at ?? this.now() });
    this.points = this.points.filter((p) => p.at >= this.now() - this.timeWindowMs).slice(-300);
    return this.status();
  }

  /**
   * Averages each metric over the newest readings and checks it against its limit.
   * Changes state: it moves a metric into or out of the active and recovered lists,
   * so calling it twice can give a different status the second time.
   * If a metric has no readings: its value is 0 and no alert fires.
   * Severity is critical when the miss is more than 0.15, otherwise a warning.
   */
  status() {
    const points = this.points.filter((p) => p.at >= this.now() - this.timeWindowMs),
      recent = points.slice(-this.sampleWindow);
    return {
      sampleWindow: this.sampleWindow,
      timeWindowMs: this.timeWindowMs,
      sampleCount: points.length,
      metrics: (Object.keys(METRIC_LIMITS) as Metric[]).map((metric) => {
        const values = recent
            .map((p) => p[metric])
            .filter((v): v is number => typeof v === 'number'),
          value = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
          limit = METRIC_LIMITS[metric],
          threshold = 'floor' in limit ? limit.floor : limit.ceiling,
          delta = 'floor' in limit ? threshold - value : value - threshold,
          alertActive = values.length > 0 && delta > 0,
          was = this.active.has(metric);
        if (alertActive) {
          this.active.add(metric);
          this.recovered.delete(metric);
        } else {
          if (was) this.recovered.add(metric);
          this.active.delete(metric);
        }
        return {
          metric,
          value,
          threshold,
          direction: 'floor' in limit ? 'below' : 'above',
          alertActive,
          status: alertActive ? 'active' : this.recovered.has(metric) ? 'recovered' : 'healthy',
          severity: delta > 0.15 ? 'critical' : 'warning',
          driftDelta: Math.max(0, delta),
          series: points
            .filter((p) => typeof p[metric] === 'number')
            .map((p) => ({ at: p.at, value: p[metric] })),
        };
      }),
    };
  }

  /**
   * Adds ten identical readings, healthy by default or poor when `degraded` is true.
   * Used by the operations page to show an alert firing.
   */
  batch({ degraded = false }: { degraded?: boolean } = {}) {
    for (let i = 0; i < 10; i++)
      this.record({
        sample: {
          responseConfidence: degraded ? 0.35 : 0.93,
          citationPassRate: degraded ? 0.4 : 0.98,
          promptGuardBlockRate: degraded ? 0.55 : 0.04,
          retrievalMatchStrength: degraded ? 0.28 : 0.88,
          schemaValidationRate: degraded ? 0.7 : 1,
          llmJudgeScore: degraded ? 0.45 : 0.94,
        },
      });
    return this.status();
  }

  /**
   * Adds 28 older readings, one per minute, that start healthy and turn poor near the end.
   * Why: so the page has a chart and an alert to show before any real traffic.
   */
  seed() {
    for (let i = 0; i < 28; i++)
      this.record({
        sample: {
          at: this.now() - (28 - i) * 60000,
          responseConfidence: i > 20 ? 0.56 : 0.88 + Math.sin(i) * 0.04,
          citationPassRate: i > 20 ? 0.7 : 0.97,
          promptGuardBlockRate: 0.06 + Math.sin(i) * 0.025,
          retrievalMatchStrength: 0.78 + Math.cos(i) * 0.06,
          schemaValidationRate: 1,
          llmJudgeScore: i > 20 ? 0.65 : 0.9,
        },
      });
  }
}

/** The shared meter. It is seeded once when this file loads. */
export const qualityMeter = new QualityMeter();

qualityMeter.seed();
