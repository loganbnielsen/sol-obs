/**
 * Sol's structured-log shape, pushed straight to Loki's HTTP push API.
 * A structured logger like pino turned out not to earn its keep for this
 * (see FEAT-033's findings, "Friction log": the interesting logic is
 * entirely the Loki push shape/labels, not log formatting/performance) --
 * plain console/fetch is used instead. Same wiring the OCaml side's Sol_obs
 * facade does internally.
 *
 * This is a straight extraction of demo_ts/{order_svc,fulfillment_worker}
 * /src/loki.ts, which were byte-for-byte identical duplicates of each
 * other -- this module is now the single shared source of truth.
 */

import { workloadIdentity } from "./identity.js";

export type LogFields = Record<string, string>;

export interface LokiPusherOptions {
  /** When set, every line is also pushed to Loki. */
  lokiUrl?: string;
  /**
   * The Loki stream's `service` label when Sol has not injected one. Inside a
   * Sol manifest `SOL_SERVICE` — the workload's bare Kubernetes name — wins, so
   * an app-pushed stream matches the collector-promoted one for the same pod.
   */
  service: string;
  /**
   * Additional low-cardinality stream labels, mirroring `Sol_obs.of_env`'s
   * `?context` (team/domain/env). Loki requires a fixed label set per stream, so
   * these are fixed at construction. An injected identity label overrides a
   * caller label of the same name; `service` is never a stream label.
   */
  labels?: Record<string, string>;
  /** The environment to read the injected identity from; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface LokiPusher {
  (level: string, msg: string, fields: LogFields): void;
  /**
   * Await the pushes still in flight. A service/worker registers this as a
   * shutdown hook so a line emitted just before the drain resolves is sent
   * rather than dropped with the process.
   */
  flush(): Promise<void>;
}

/**
 * OBS-048 part A: every log line is on stdout as well as in Loki, so
 * `kubectl logs` has it and a Loki outage does not lose it. The console copy is
 * the structured JSON form; the Loki copy below is logfmt.
 */
function writeConsoleLine(service: string, level: string, msg: string, fields: LogFields): void {
  console.log(JSON.stringify({ service, level, msg, ...fields }));
}

export function makeLokiPusher(opts: LokiPusherOptions): LokiPusher {
  const identity = workloadIdentity(opts.env);
  const service = identity.service ?? opts.service;
  const stream = { ...opts.labels, ...identity, service };
  const pending = new Set<Promise<void>>();

  const push = ((level: string, msg: string, fields: LogFields): void => {
    writeConsoleLine(service, level, msg, fields);

    const lokiUrl = opts.lokiUrl;
    if (!lokiUrl) return;

    const line = Object.entries({ level, msg, ...fields })
      .map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`)
      .join(" ");
    const nanos = String(Date.now()) + "000000";
    const body = { streams: [{ stream, values: [[nanos, line]] }] };

    const inFlight = fetch(`${lokiUrl}/loki/api/v1/push`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (response) => {
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 200);
          console.error(`[${service}] loki push failed: HTTP ${response.status} ${detail}`);
        }
      })
      .catch((err) => {
        console.error(`[${service}] loki push failed: ${String(err)}`);
      });

    pending.add(inFlight);
    void inFlight.finally(() => pending.delete(inFlight));
  }) as LokiPusher;

  push.flush = async (): Promise<void> => {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
  };

  return push;
}
