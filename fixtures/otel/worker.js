// "worker": GET /work does a little work; POST /message consumes a "message"
// in a new trace whose span links to the producer's.
const http = require("node:http");
const { propagation, ROOT_CONTEXT, SpanKind, trace } = require("@opentelemetry/api");

const tracer = trace.getTracer("auxin-fixture");

http
  .createServer((req, res) => {
    if (req.url !== "/message") return void res.end("done");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const producer = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, JSON.parse(body)));
      tracer.startSpan("orders process", { kind: SpanKind.CONSUMER, root: true, links: producer ? [{ context: producer }] : [] }).end();
      res.end("consumed");
    });
  })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("worker ready"));
