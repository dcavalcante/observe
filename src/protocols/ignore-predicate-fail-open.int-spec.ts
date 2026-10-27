import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { ExpressAdapter } from "@nestjs/platform-express";
import { NestExpressApplication } from "@nestjs/platform-express";
import {
  ClientProxy,
  ClientProxyFactory,
  MessagePattern,
  Payload,
  Transport,
} from "@nestjs/microservices";
import { GraphQLModule, Query, Resolver } from "@nestjs/graphql";
import { WsAdapter } from "@nestjs/platform-ws";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import request from "supertest";
import { firstValueFrom } from "rxjs";
import { WebSocket } from "ws";
import { createObserveModule } from "../observe.module.js";
import {
  collectSnapshots,
  freePort,
  testObserveOptions,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

let httpExecutions = 0;
@Controller()
class HttpIgnoreController {
  @Get("probe")
  run() {
    httpExecutions++;
    return { ok: true };
  }

  @Get("broken")
  fail() {
    httpExecutions++;
    throw new Error("business failure");
  }
}
@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        http: {
          ignore: () => {
            throw new Error("private callback detail");
          },
        },
      }),
    ),
  ],
  controllers: [HttpIgnoreController],
})
class HttpIgnoreModule {}

let graphqlExecutions = 0;
@Resolver()
class GraphqlIgnoreResolver {
  @Query(() => Boolean)
  probe() {
    graphqlExecutions++;
    return true;
  }
}
@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        graphql: {
          ignore: () => {
            throw new Error("private callback detail");
          },
        },
      }),
    ),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      playground: false,
    }),
  ],
  providers: [GraphqlIgnoreResolver],
})
class GraphqlIgnoreModule {}

let rpcExecutions = 0;
@Controller()
class RpcIgnoreController {
  @MessagePattern("probe")
  run(@Payload() _payload: unknown) {
    rpcExecutions++;
    return { ok: true };
  }

  @MessagePattern("broken")
  fail() {
    rpcExecutions++;
    throw new Error("business failure");
  }
}
@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        rpc: {
          ignore: () => {
            throw new Error("private callback detail");
          },
        },
      }),
    ),
  ],
  controllers: [RpcIgnoreController],
})
class RpcIgnoreModule {}

let wsExecutions = 0;
@WebSocketGateway()
class WsIgnoreGateway {
  @SubscribeMessage("probe")
  run(@MessageBody() _body: unknown) {
    wsExecutions++;
    return { event: "probe", data: true };
  }
}
@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        ws: {
          ignore: () => {
            throw new Error("private callback detail");
          },
        },
      }),
    ),
  ],
  providers: [WsIgnoreGateway],
})
class WsIgnoreModule {}

describe("throwing ignore predicates fail open for business execution", () => {
  it("serves an HTTP request without collecting it", async () => {
    const app = await NestFactory.create(
      HttpIgnoreModule,
      new ExpressAdapter(),
      {
        instrument: ObserveInstrument,
        logger: false,
      },
    );
    const collected = collectSnapshots(app);
    await app.init();
    httpExecutions = 0;

    const response = await request(app.getHttpServer())
      .get("/probe")
      .expect(200);

    expect(response.body).toEqual({ ok: true });
    expect(httpExecutions).toBe(1);
    expect(collected.items).toHaveLength(0);
    await app.close();
  });

  it("preserves an HTTP handler failure after the ignore predicate throws", async () => {
    const app = await NestFactory.create(HttpIgnoreModule, new ExpressAdapter(), {
      instrument: ObserveInstrument,
      logger: false,
    });
    const collected = collectSnapshots(app);
    await app.init();
    httpExecutions = 0;

    await request(app.getHttpServer()).get("/broken").expect(500);

    expect(httpExecutions).toBe(1);
    expect(collected.items).toHaveLength(0);
    await app.close();
  });

  it("serves a GraphQL operation without collecting it", async () => {
    const app = await NestFactory.create(
      GraphqlIgnoreModule,
      new ExpressAdapter(),
      {
        instrument: ObserveInstrument,
        logger: false,
      },
    );
    const collected = collectSnapshots(app);
    await app.init();
    graphqlExecutions = 0;

    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: "{ probe }" })
      .expect(200);

    expect(response.body).toMatchObject({ data: { probe: true } });
    expect(graphqlExecutions).toBe(1);
    expect(collected.items).toHaveLength(0);
    await app.close();
  });

  it("returns the RPC handler result without collecting it", async () => {
    const port = await freePort();
    const app = await NestFactory.createMicroservice(RpcIgnoreModule, {
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port },
      instrument: ObserveInstrument,
      logger: false,
    } as never);
    const collected = collectSnapshots(app);
    await app.listen();
    const client: ClientProxy = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port },
    });
    await client.connect();
    rpcExecutions = 0;

    const result = await Promise.race([
      firstValueFrom(client.send("probe", {})),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("RPC response timed out")), 3000),
      ),
    ]);

    expect(result).toEqual({ ok: true });
    expect(rpcExecutions).toBe(1);
    expect(collected.items).toHaveLength(0);
    await client.close();
    await app.close();
  });

  it("preserves an RPC handler failure after the ignore predicate throws", async () => {
    const port = await freePort();
    const app = await NestFactory.createMicroservice(RpcIgnoreModule, {
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port },
      instrument: ObserveInstrument,
      logger: false,
    } as never);
    const collected = collectSnapshots(app);
    await app.listen();
    const client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port },
    });
    await client.connect();
    rpcExecutions = 0;

    await expect(firstValueFrom(client.send("broken", {}))).rejects.toBeDefined();

    expect(rpcExecutions).toBe(1);
    expect(collected.items).toHaveLength(0);
    await client.close();
    await app.close();
  });

  it("replies to a WebSocket message without collecting it", async () => {
    const app = await NestFactory.create<NestExpressApplication>(
      WsIgnoreModule,
      {
        instrument: ObserveInstrument,
        logger: false,
      },
    );
    app.useWebSocketAdapter(new WsAdapter(app));
    const collected = collectSnapshots(app);
    const port = await freePort();
    await app.listen(port);
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    wsExecutions = 0;

    const reply = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("WebSocket response timed out")),
        3000,
      );
      client.once("message", (raw) => {
        clearTimeout(timeout);
        const encoded = Array.isArray(raw)
          ? Buffer.concat(raw).toString()
          : Buffer.isBuffer(raw)
            ? raw.toString()
            : Buffer.from(new Uint8Array(raw)).toString();
        resolve(JSON.parse(encoded));
      });
    });
    client.send(JSON.stringify({ event: "probe", data: true }));

    expect(await reply).toEqual({ event: "probe", data: true });
    expect(wsExecutions).toBe(1);
    expect(collected.items).toHaveLength(0);
    client.close();
    await app.close();
  });
});
