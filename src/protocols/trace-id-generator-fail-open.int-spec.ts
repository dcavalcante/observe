import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { GraphQLModule, Query, Resolver } from "@nestjs/graphql";
import {
  ClientProxyFactory,
  GrpcMethod,
  MessagePattern,
  Payload,
  Transport,
} from "@nestjs/microservices";
import { Test } from "@nestjs/testing";
import { credentials, loadPackageDefinition } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import request from "supertest";
import { firstValueFrom } from "rxjs";
import { join } from "node:path";
import { createObserveModule } from "../observe.module.js";
import { HttpObserveAgentService } from "./http-observe-agent.service.js";
import {
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const PROTO_PATH = join(
  import.meta.dirname,
  "..",
  "testing",
  "orders.test.proto",
);
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let httpRuns = 0;
const httpObserve = createObserveModule({
  traceIdGenerator: () => {
    throw new Error("private generator detail");
  },
});
@Controller()
class HttpGeneratorController {
  @Get("probe")
  run() {
    httpRuns++;
    return { ok: true };
  }

  @Get("broken")
  fail() {
    httpRuns++;
    throw new Error("business failure");
  }
}
@Module({
  imports: [httpObserve.ObserveModule.forRoot(testObserveOptions())],
  controllers: [HttpGeneratorController],
})
class HttpGeneratorModule {}

let rpcRuns = 0;
const rpcObserve = createObserveModule({
  traceIdGenerator: () => {
    throw new Error("private generator detail");
  },
});
@Controller()
class RpcGeneratorController {
  @MessagePattern("probe")
  run(@Payload() _payload: unknown) {
    rpcRuns++;
    return { ok: true };
  }

  @MessagePattern("broken")
  fail() {
    rpcRuns++;
    throw new Error("business failure");
  }
}
@Module({
  imports: [rpcObserve.ObserveModule.forRoot(testObserveOptions())],
  controllers: [RpcGeneratorController],
})
class RpcGeneratorModule {}

let grpcRuns = 0;
const grpcObserve = createObserveModule({
  traceIdGenerator: () => {
    throw new Error("private generator detail");
  },
});
@Controller()
class GrpcGeneratorController {
  @GrpcMethod("Orders", "FindOne")
  findOne(data: { id: string }) {
    grpcRuns++;
    return { id: data.id, name: "ok" };
  }

  @GrpcMethod("Orders", "Explode")
  explode(): never {
    grpcRuns++;
    throw new Error("business failure");
  }
}
@Module({
  imports: [grpcObserve.ObserveModule.forRoot(testObserveOptions())],
  controllers: [GrpcGeneratorController],
})
class GrpcGeneratorModule {}

let graphqlRuns = 0;
const graphqlObserve = createObserveModule({
  traceIdGenerator: () => {
    throw new Error("private generator detail");
  },
});
@Resolver()
class GraphqlGeneratorResolver {
  @Query(() => Boolean)
  probe() {
    graphqlRuns++;
    return true;
  }
}
@Module({
  imports: [
    graphqlObserve.ObserveModule.forRoot(testObserveOptions()),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      playground: false,
    }),
  ],
  providers: [GraphqlGeneratorResolver],
})
class GraphqlGeneratorModule {}

async function createRpcClient(port: number) {
  const client = ClientProxyFactory.create({
    transport: Transport.TCP,
    options: { host: "127.0.0.1", port },
  });
  await client.connect();
  return client;
}

async function startGrpcClient(port: number) {
  const url = `127.0.0.1:${port}`;
  const definition = loadSync(PROTO_PATH, {
    keepCase: true,
    defaults: true,
    oneofs: true,
  });
  const proto = loadPackageDefinition(definition) as any;
  return new proto.orderstest.Orders(url, credentials.createInsecure());
}

describe("throwing traceIdGenerator callbacks fail open", () => {
  it("uses the upstream HTTP id, serves the request, and ships one snapshot", async () => {
    const app = await NestFactory.create(
      HttpGeneratorModule,
      new ExpressAdapter(),
      { instrument: httpObserve.ObserveInstrument, logger: false },
    );
    const snapshots = collectSnapshots(app);
    await app.init();
    httpRuns = 0;

    const response = await request(app.getHttpServer())
      .get("/probe")
      .set("x-request-id", "upstream-http-id")
      .expect(200);
    const snapshot = await waitForSnapshot(snapshots, () => true);

    expect(response.body).toEqual({ ok: true });
    expect(httpRuns).toBe(1);
    expect(snapshots.items).toHaveLength(1);
    expect(snapshot.traceId).toBe("upstream-http-id");
    expect(snapshot.protocol).toBe("http");
    await app.close();
  });

  it("preserves HTTP business errors after the generator fails", async () => {
    const app = await NestFactory.create(
      HttpGeneratorModule,
      new ExpressAdapter(),
      { instrument: httpObserve.ObserveInstrument, logger: false },
    );
    const snapshots = collectSnapshots(app);
    await app.init();
    httpRuns = 0;

    await request(app.getHttpServer()).get("/broken").expect(500);
    const snapshot = await waitForSnapshot(snapshots, () => true);

    expect(httpRuns).toBe(1);
    expect(snapshot.error?.message).toBe("business failure");
    await app.close();
  });

  it("serves TCP RPC requests and returns trace snapshots", async () => {
    const port = await freePort();
    const app = await NestFactory.createMicroservice(RpcGeneratorModule, {
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port },
      instrument: rpcObserve.ObserveInstrument,
      logger: false,
    } as never);
    const snapshots = collectSnapshots(app);
    await app.listen();
    const client = await createRpcClient(port);
    rpcRuns = 0;

    const result = await firstValueFrom(client.send("probe", {}));
    const snapshot = await waitForSnapshot(snapshots, () => true);

    expect(result).toEqual({ ok: true });
    expect(rpcRuns).toBe(1);
    expect(snapshots.items).toHaveLength(1);
    expect(snapshot.traceId).toMatch(UUID_V7);
    expect(snapshot.protocol).toBe("TCP");
    await client.close();
    await app.close();
  });

  it("preserves TCP RPC business errors after the generator fails", async () => {
    const port = await freePort();
    const app = await NestFactory.createMicroservice(RpcGeneratorModule, {
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port },
      instrument: rpcObserve.ObserveInstrument,
      logger: false,
    } as never);
    const snapshots = collectSnapshots(app);
    await app.listen();
    const client = await createRpcClient(port);
    rpcRuns = 0;

    await expect(
      firstValueFrom(client.send("broken", {})),
    ).rejects.toBeDefined();
    const snapshot = await waitForSnapshot(snapshots, () => true);

    expect(rpcRuns).toBe(1);
    expect(snapshot.error?.message).toBe("business failure");
    await client.close();
    await app.close();
  });

  it("serves gRPC requests and returns trace snapshots", async () => {
    const port = await freePort();
    const url = `127.0.0.1:${port}`;
    const app = await NestFactory.createMicroservice(GrpcGeneratorModule, {
      transport: Transport.GRPC,
      options: { package: "orderstest", protoPath: PROTO_PATH, url },
      instrument: grpcObserve.ObserveInstrument,
      logger: false,
    } as never);
    const snapshots = collectSnapshots(app);
    await app.listen();
    const client = await startGrpcClient(port);
    grpcRuns = 0;

    const response = await new Promise((resolve, reject) =>
      client.FindOne({ id: "42" }, (error: unknown, value: unknown) =>
        error ? reject(error) : resolve(value),
      ),
    );
    const snapshot = await waitForSnapshot(snapshots, () => true);

    expect(response).toMatchObject({ id: "42", name: "ok" });
    expect(grpcRuns).toBe(1);
    expect(snapshots.items).toHaveLength(1);
    expect(snapshot.traceId).toMatch(UUID_V7);
    expect(snapshot.protocol).toBe("GRPC");
    client.close();
    await app.close();
  });

  it("preserves gRPC business errors after the generator fails", async () => {
    const port = await freePort();
    const url = `127.0.0.1:${port}`;
    const app = await NestFactory.createMicroservice(GrpcGeneratorModule, {
      transport: Transport.GRPC,
      options: { package: "orderstest", protoPath: PROTO_PATH, url },
      instrument: grpcObserve.ObserveInstrument,
      logger: false,
    } as never);
    const snapshots = collectSnapshots(app);
    await app.listen();
    const client = await startGrpcClient(port);
    grpcRuns = 0;

    await expect(
      new Promise((resolve, reject) =>
        client.Explode({ id: "42" }, (error: unknown, value: unknown) =>
          error ? reject(error) : resolve(value),
        ),
      ),
    ).rejects.toBeDefined();
    const snapshot = await waitForSnapshot(snapshots, () => true);

    expect(grpcRuns).toBe(1);
    expect(snapshot.error?.message).toBe("business failure");
    client.close();
    await app.close();
  });

  it("traces standalone GraphQL operations without an enclosing HTTP trace", async () => {
    const testingModule = await Test.createTestingModule({
      imports: [GraphqlGeneratorModule],
    })
      // Standalone GraphQL owns the trace only when no HTTP trace is present.
      // Disable the HTTP agent so this request exercises that branch directly.
      .overrideProvider(HttpObserveAgentService)
      .useValue({})
      .compile();
    const app = testingModule.createNestApplication(new ExpressAdapter(), {
      instrument: graphqlObserve.ObserveInstrument,
      logger: false,
    });
    const snapshots = collectSnapshots(app);
    await app.init();
    graphqlRuns = 0;

    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: "{ probe }" })
      .expect(200);
    const snapshot = await waitForSnapshot(snapshots, () => true);

    expect(response.body).toMatchObject({ data: { probe: true } });
    expect(graphqlRuns).toBe(1);
    expect(snapshots.items).toHaveLength(1);
    expect(snapshot.protocol).toBe("graphql");
    expect(snapshot.traceId).toMatch(UUID_V7);
    await app.close();
  });
});
