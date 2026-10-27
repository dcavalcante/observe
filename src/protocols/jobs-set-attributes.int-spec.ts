import { INestApplication, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ScheduleModule, Timeout } from "@nestjs/schedule";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedJobSnapshots,
  collectJobSnapshots,
  testObserveOptions,
  waitForJobSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();
let processorCalls = 0;
let attributeCalls = 0;

@Injectable()
class ScheduledAttributesJobs {
  @Timeout("attributes-ok", 30)
  runNormally() {
    processorCalls++;
    return "done";
  }

  @Timeout("business-error", 60)
  runWithBusinessError() {
    processorCalls++;
    throw new Error("scheduled business error");
  }
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ObserveModule.forRoot(
      testObserveOptions({
        jobs: {
          setAttributes() {
            attributeCalls++;
            throw new Error("job attributes failed");
          },
        },
      }),
    ),
  ],
  providers: [ScheduledAttributesJobs],
})
class JobsSetAttributesModule {}

describe("scheduled jobs setAttributes fail-open integration", () => {
  let app: INestApplication;
  let snapshots: CollectedJobSnapshots;

  beforeAll(async () => {
    processorCalls = 0;
    attributeCalls = 0;
    app = await NestFactory.create(JobsSetAttributesModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    snapshots = collectJobSnapshots(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("runs scheduled processors and completes their snapshots", async () => {
    const snapshot = await waitForJobSnapshot(
      snapshots,
      (item) => item.name === "attributes-ok",
    );
    expect(snapshot.status).toBe("completed");
    expect(processorCalls).toBe(1);
    expect(attributeCalls).toBe(1);
  });

  it("preserves the scheduled handler's business error", async () => {
    const snapshot = await waitForJobSnapshot(
      snapshots,
      (item) => item.name === "business-error",
    );
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toMatchObject({
      message: "scheduled business error",
    });
    expect(processorCalls).toBe(2);
    expect(attributeCalls).toBe(2);
  });
});
