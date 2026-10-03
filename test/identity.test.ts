import { test } from "node:test";
import assert from "node:assert/strict";
import { SOL_WORKLOAD_IDENTITY, resourceAttributes, workloadIdentity } from "../src/identity.js";
import { makeLokiPusher } from "../src/loki.js";

const ENV = {
  SOL_WORKSPACE: "pluto",
  SOL_ENV: "prod",
  SOL_DOMAIN: "checkout",
  SOL_SERVICE: "charge-svc",
  SOL_PRIMITIVE: "svc",
  SOL_RELEASE: "v1.2.3",
};

const IDENTITY = {
  workspace: "pluto",
  env: "prod",
  domain: "checkout",
  service: "charge-svc",
  primitive: "svc",
  release: "v1.2.3",
};

interface PushBody {
  streams: { stream: Record<string, string>; values: string[][] }[];
}

function stubFetch(calls: { url: string; body: PushBody }[]) {
  const originalFetch = globalThis.fetch;
  // @ts-expect-error -- test stub, narrower than the real fetch signature
  globalThis.fetch = async (url: string, opts: { body: string }) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true } as Response;
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("the identity keys are exactly Sol's six, in taxonomy order", () => {
  assert.deepEqual(
    SOL_WORKLOAD_IDENTITY.map(([, label]) => label),
    ["workspace", "env", "domain", "service", "primitive", "release"],
  );
});

test("workloadIdentity reads the set variables, trims them, and never emits a blank label", () => {
  assert.deepEqual(workloadIdentity(ENV), IDENTITY);
  assert.deepEqual(workloadIdentity({ ...ENV, SOL_ENV: "   ", SOL_RELEASE: undefined }), {
    workspace: "pluto",
    domain: "checkout",
    service: "charge-svc",
    primitive: "svc",
  });
  assert.deepEqual(workloadIdentity({}), {});
});

test("resourceAttributes: service.name is the injected SOL_SERVICE and all six labels ride along", () => {
  assert.deepEqual(resourceAttributes("app-chosen-name", {}, ENV), {
    "service.name": "charge-svc",
    ...IDENTITY,
  });
});

test("resourceAttributes: outside a manifest it falls back to the caller's service", () => {
  assert.deepEqual(resourceAttributes("order-svc-ts", {}, {}), {
    "service.name": "order-svc-ts",
    service: "order-svc-ts",
  });
});

test("resourceAttributes: an injected label wins over a caller context of the same name", () => {
  const attrs = resourceAttributes("order-svc-ts", { domain: "wrong", team: "payments" }, ENV);
  assert.equal(attrs.domain, "checkout");
  assert.equal(attrs.team, "payments");
});

test("makeLokiPusher: the injected identity is the stream, and it wins over caller labels", async () => {
  const calls: { url: string; body: PushBody }[] = [];
  const restoreFetch = stubFetch(calls);
  try {
    const push = makeLokiPusher({
      lokiUrl: "http://loki.local",
      service: "order-svc-ts",
      labels: { team: "demo_ts", domain: "wrong" },
      env: ENV,
    });
    push("info", "hello", {});
    await push.flush();
  } finally {
    restoreFetch();
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.streams[0].stream, {
    team: "demo_ts",
    ...IDENTITY,
  });
});

test("makeLokiPusher: outside a manifest the caller's service is the stream's only label", async () => {
  const calls: { url: string; body: PushBody }[] = [];
  const restoreFetch = stubFetch(calls);
  try {
    const push = makeLokiPusher({ lokiUrl: "http://loki.local", service: "order-svc-ts", env: {} });
    push("info", "hello", {});
    await push.flush();
  } finally {
    restoreFetch();
  }
  assert.deepEqual(calls[0].body.streams[0].stream, { service: "order-svc-ts" });
});
