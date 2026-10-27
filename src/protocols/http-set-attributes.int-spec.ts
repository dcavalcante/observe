import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import {
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();
let handlerCalls = 0;
let attributeCalls = 0;

@Controller()
class AttributesController {
  @Get("ok")
  ok() {
    handlerCalls++;
    return { ok: true };
  }

  @Get("business-error")
  businessError() {
    throw new Error("business handler failed");
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        http: {
          setAttributes() {
            attributeCalls++;
            throw new Error("http attributes failed");
          },
        },
      }),
    ),
  ],
  controllers: [AttributesController],
})
class HttpSetAttributesModule {}

describe("HTTP setAttributes fail-open integration", () => {
  let app: INestApplication;
  let snapshots: ReturnType<typeof collectSnapshots>;

  beforeAll(async () => {
    handlerCalls = 0;
    attributeCalls = 0;
    app = await NestFactory.create(
      HttpSetAttributesModule,
      new ExpressAdapter(),
      { instrument: ObserveInstrument, logger: false },
    );
    snapshots = collectSnapshots(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("executes a successful handler and ships its trace", async () => {
    await request(app.getHttpServer()).get("/ok").expect(200, { ok: true });
    const snapshot = await waitForSnapshot(
      snapshots,
      (item) => item.operationId === "/ok",
    );

    expect(handlerCalls).toBe(1);
    expect(attributeCalls).toBe(1);
    expect(snapshot.protocol).toBe("http");
  });

  it("keeps business handler errors as HTTP 500", async () => {
    await request(app.getHttpServer()).get("/business-error").expect(500);
    expect(handlerCalls).toBe(1);
    expect(attributeCalls).toBe(2);
  });
});
