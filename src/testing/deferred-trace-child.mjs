import { NestFactory } from "@nestjs/core";
import { Controller, Get, Module } from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { createObserveModule } from "../../dist/observe.module.js";
import { ObserveAgentSharedBuffer } from "../../dist/agent/observe-agent.shared-buffer.js";

const throws = process.env.THROW_USER_ID === "1";
let callbackCalls = 0;
const { ObserveModule, ObserveInstrument } = createObserveModule();
class ReproController {
  request() {
    return { ok: true };
  }
}
Controller()(ReproController);
Get("unauthenticated")(
  ReproController.prototype,
  "request",
  Object.getOwnPropertyDescriptor(ReproController.prototype, "request"),
);
class ReproModule {}
Module({
  imports: [
    ObserveModule.forRoot({
      appKey: "key",
      appSecret: "secret",
      serviceId: "00000000-0000-4000-8000-000000000000",
      runtimeMetrics: false,
      forwardLogs: false,
      flushInterval: 60_000,
      http: {
        getUserId() {
          callbackCalls++;
          if (throws) throw new Error("getUserId exploded");
          return "user-123";
        },
      },
    }),
  ],
  controllers: [ReproController],
})(ReproModule);

const delivered = [];
const original = ObserveAgentSharedBuffer.prototype["insertRequestSnapshot"];
ObserveAgentSharedBuffer.prototype.insertRequestSnapshot = function (snapshot) {
  delivered.push(snapshot.userId);
  return Reflect.apply(original, this, [snapshot]);
};
const app = await NestFactory.create(ReproModule, new ExpressAdapter(), {
  instrument: ObserveInstrument,
  logger: false,
});
await app.listen(0, "127.0.0.1");
process.stdout.write(`READY ${app.getHttpServer().address().port}\n`);
setTimeout(async () => {
  process.stdout.write(`RESULT ${JSON.stringify({ callbackCalls, delivered })}\n`);
  await app.close();
}, 150);
