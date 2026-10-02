import { test } from "node:test";
import assert from "node:assert/strict";
import { makeLokiPusher } from "../src/loki.js";

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

test("with no lokiUrl, falls back to structured console.log, no fetch", () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => logs.push(line);
  try {
    const push = makeLokiPusher({ service: "order-svc" });
    push("info", "hello", { orderId: "123" });
  } finally {
    console.log = originalLog;
  }
  assert.equal(logs.length, 1);
  const parsed = JSON.parse(logs[0]);
  assert.equal(parsed.service, "order-svc");
  assert.equal(parsed.level, "info");
  assert.equal(parsed.msg, "hello");
  assert.equal(parsed.orderId, "123");
});

test("with a lokiUrl, pushes to the Loki HTTP push API and still copies the line to the console", async () => {
  const calls: { url: string; body: PushBody }[] = [];
  const logs: string[] = [];
  const restoreFetch = stubFetch(calls);
  const originalLog = console.log;
  console.log = (line: string) => logs.push(line);
  try {
    const push = makeLokiPusher({ lokiUrl: "http://loki.local", service: "fulfillment-worker" });
    push("error", "boom", { orderId: "456" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreFetch();
    console.log = originalLog;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://loki.local/loki/api/v1/push");
  assert.equal(calls[0].body.streams[0].stream.service, "fulfillment-worker");
  assert.match(calls[0].body.streams[0].values[0][1], /level="error"/);
  assert.match(calls[0].body.streams[0].values[0][1], /orderId="456"/);
  // OBS-048 part A: the line is on stdout too, so a Loki outage cannot lose it.
  assert.equal(logs.length, 1);
  const parsed = JSON.parse(logs[0]);
  assert.equal(parsed.service, "fulfillment-worker");
  assert.equal(parsed.level, "error");
  assert.equal(parsed.msg, "boom");
  assert.equal(parsed.orderId, "456");
});

test("labels are fixed at construction and carried on the stream, with service winning", async () => {
  const calls: { url: string; body: PushBody }[] = [];
  const restoreFetch = stubFetch(calls);
  const originalLog = console.log;
  console.log = () => {};
  try {
    const push = makeLokiPusher({
      lokiUrl: "http://loki.local",
      service: "charge-svc",
      labels: { team: "payments", service: "not-this" },
    });
    push("info", "charged", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    restoreFetch();
    console.log = originalLog;
  }
  assert.deepEqual(calls[0].body.streams[0].stream, { team: "payments", service: "charge-svc" });
});

test("flush awaits pushes still in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    await gate;
    return { ok: true } as Response;
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    const push = makeLokiPusher({ lokiUrl: "http://loki.local", service: "order-svc" });
    push("info", "last words", {});
    let flushed = false;
    const flushing = push.flush().then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(flushed, false, "flush must not resolve while the push is in flight");
    release();
    await flushing;
    assert.equal(flushed, true);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("flush resolves immediately when there is nothing to send", async () => {
  const push = makeLokiPusher({ service: "order-svc" });
  await push.flush();
});

test("reports a non-2xx Loki response with bounded detail", async () => {
  const errors: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalLog = console.log;
  globalThis.fetch = async () => new Response("x".repeat(500), { status: 429 });
  console.error = (message: string) => errors.push(message);
  console.log = () => {};
  try {
    makeLokiPusher({ lokiUrl: "http://loki.local", service: "order-svc" })("warn", "slow", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.log = originalLog;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /HTTP 429/);
  assert.ok(errors[0].length < 270);
});
