// "api": GET /orders calls the worker over HTTP, then publishes a message the
// worker handles in a trace of its own, linked back (as messaging spans are).
const http = require("node:http");
const { context, propagation, SpanKind, trace } = require("@opentelemetry/api");

const tracer = trace.getTracer("auxin-fixture");
const worker = `http://127.0.0.1:${process.env.WORKER_PORT}`;

http
  .createServer(async (_req, res) => {
    await fetch(`${worker}/work`);
    const message = {};
    tracer.startActiveSpan(
      "orders publish",
      { kind: SpanKind.PRODUCER, attributes: { "messaging.system": "rabbitmq", "messaging.destination.name": "orders" } },
      (span) => {
        propagation.inject(context.active(), message);
        span.end();
      },
    );
    await fetch(`${worker}/message`, { method: "POST", body: JSON.stringify(message) });
    res.end("ok");
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("api ready"));
