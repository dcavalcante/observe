import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { freePort } from "../testing/observe-harness.js";

const PROTO_PATH = join(
  import.meta.dirname,
  "..",
  "testing",
  "orders.test.proto",
);

const CHILD = String.raw`
import "reflect-metadata";
import { Controller, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { GrpcMethod, Transport } from "@nestjs/microservices";
import { credentials, loadPackageDefinition } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { createObserveModule } from "./dist/observe.module.js";
import { ObserveAgentSharedBuffer } from "./dist/agent/observe-agent.shared-buffer.js";
import { OperationTraceRegistry } from "./dist/services/operation-trace.registry.js";

const failure = process.env.FAILURE_MODE;
let handlerCount = 0;
let traceStarts = 0;
let snapshotCount = 0;
let responseCallbackCount = 0;
process.on("exit", () => {
  process.stdout.write(
    "FINAL_STATE:" +
      JSON.stringify({
        handlerCount,
        traceStarts,
        snapshotCount,
        responseCallbackCount,
      }) +
      "\n",
  );
});
class OrdersController {
  findOne(data) {
    handlerCount++;
    process.stdout.write("HANDLER_EXECUTED\n");
    return { id: data.id, name: "order-" + data.id };
  }
}
Controller()(OrdersController);
GrpcMethod("Orders", "FindOne")(
  OrdersController.prototype,
  "findOne",
  Object.getOwnPropertyDescriptor(OrdersController.prototype, "findOne"),
);
class TestModule {}
const { ObserveModule, ObserveInstrument } = createObserveModule();
const callbackFailure = () => { throw new Error(failure + " callback exploded"); };
Module({
  imports: [ObserveModule.forRoot({
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    serviceId: "00000000-0000-4000-8000-000000000000",
    runtimeMetrics: false,
    forwardLogs: false,
    flushInterval: 60000,
    grpc: { ignore: failure === "ignore" ? callbackFailure : () => false },
    tracesSampleRate: failure === "sampling" ? callbackFailure : 1,
  })],
  controllers: [OrdersController],
})(TestModule);

const app = await NestFactory.createMicroservice(TestModule, {
  transport: Transport.GRPC,
  options: {
    package: "orderstest",
    protoPath: process.env.PROTO_PATH,
    url: process.env.GRPC_URL,
  },
  instrument: ObserveInstrument,
  logger: false,
});
const registry = app.get(OperationTraceRegistry, { strict: false });
const startTrace = registry.startTrace.bind(registry);
registry.startTrace = (...args) => { traceStarts++; return startTrace(...args); };
const sharedBuffer = app.get(ObserveAgentSharedBuffer, { strict: false });
sharedBuffer.insertRequestSnapshot = () => { snapshotCount++; };
await app.listen();

const definition = loadSync(process.env.PROTO_PATH, {
  keepCase: true, defaults: true, oneofs: true,
});
const proto = loadPackageDefinition(definition);
const client = new proto.orderstest.Orders(
  process.env.GRPC_URL,
  credentials.createInsecure(),
);
console.log("CALL_STARTED");
const response = await new Promise((resolve, reject) => {
  client.FindOne({ id: "42" }, (error, value) => {
    responseCallbackCount++;
    error ? reject(error) : resolve(value);
  });
});
console.log("RESULT:" + JSON.stringify({ response, handlerCount }));
client.close();
await app.close();
`;

describe("ObserveModule: gRPC deferred startup callback failures", () => {
  it.each(["ignore", "sampling"] as const)(
    "fails open for a throwing %s callback without capturing the operation",
    async (failureMode) => {
      const port = await freePort();
      const url = `127.0.0.1:${port}`;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", CHILD],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            FAILURE_MODE: failureMode,
            PROTO_PATH,
            GRPC_URL: url,
          },
        },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("CALL_STARTED");
      expect(result.stdout).toContain("HANDLER_EXECUTED");
      const resultLine = result.stdout
        .split("\n")
        .find((line) => line.startsWith("RESULT:"));
      expect(resultLine).toBeDefined();
      expect(JSON.parse(resultLine!.slice("RESULT:".length))).toEqual({
        response: { id: "42", name: "order-42" },
        handlerCount: 1,
      });
      const finalStateLine = result.stdout
        .split("\n")
        .find((line) => line.startsWith("FINAL_STATE:"));
      expect(finalStateLine).toBeDefined();
      expect(JSON.parse(finalStateLine!.slice("FINAL_STATE:".length))).toEqual({
        handlerCount: 1,
        traceStarts: 0,
        snapshotCount: 0,
        responseCallbackCount: 1,
      });
    },
  );
});
