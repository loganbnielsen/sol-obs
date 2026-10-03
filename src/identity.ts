/**
 * Sol's semantic workload identity (DEC-064).
 *
 * The deployment layer injects the six values below as environment variables on
 * every workload — the same values it renders as pod labels — and the framework
 * owns emitting them on every signal. This module is the TypeScript half of that
 * contract: `Sol_obs.of_env` composes the identity for OCaml, and
 * `makeLokiPusher`/`resourceAttributes` compose the identical six labels here.
 *
 * The variable names and label names must stay in step with
 * `framework/ocaml/sol-obs/lib/sol_obs.ml` (`Sol_obs.taxonomy`) and the
 * manifest's `observability_identity`. Adding a label means changing all three,
 * and `check_observability_identity.py` in the Sol repository fails if they
 * drift.
 */
export const SOL_WORKLOAD_IDENTITY: ReadonlyArray<readonly [variable: string, label: string]> = [
  ["SOL_WORKSPACE", "workspace"],
  ["SOL_ENV", "env"],
  ["SOL_DOMAIN", "domain"],
  ["SOL_SERVICE", "service"],
  ["SOL_PRIMITIVE", "primitive"],
  ["SOL_RELEASE", "release"],
];

/** The identity labels that are present, keyed by label name. */
export type WorkloadIdentity = Readonly<Record<string, string>>;

/**
 * Read the injected identity. A variable that is unset, empty or whitespace is
 * absent, exactly as `Sol_obs.identity` treats it — never a blank label.
 */
export function workloadIdentity(
  env: Record<string, string | undefined> = process.env,
): WorkloadIdentity {
  const identity: Record<string, string> = {};
  for (const [variable, label] of SOL_WORKLOAD_IDENTITY) {
    const value = env[variable]?.trim();
    if (value) identity[label] = value;
  }
  return identity;
}

/**
 * The OpenTelemetry resource attributes for a trace, mirroring
 * `Obs_tempo.resource_attributes ~service context`: `service.name` plus the
 * context pairs, with the injected identity winning. `service` is the Sol
 * `service` label — the workload's bare Kubernetes name, not the application's
 * chosen name — so a trace is scoped exactly as the collector-scraped logs and
 * metrics for the same workload are.
 */
export function resourceAttributes(
  service: string,
  context: Readonly<Record<string, string>> = {},
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const identity = workloadIdentity(env);
  const resolved = identity.service ?? service;
  return { "service.name": resolved, ...context, ...identity, service: resolved };
}
