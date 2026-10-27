import { ServerKafka, Transport } from "@nestjs/microservices";
import { AsyncLocalStorage } from "async_hooks";
import { RpcObserveAgentService } from "./rpc-observe-agent.service.js";

/**
 * `@nestjs/microservices` is an optional peer: the agent must hook RPC
 * targets when it is installed and stay inert - not crash the module - when
 * it is not. The loader is stubbed for the latter; the package is always
 * present in this repository's own dependencies.
 */
describe("RpcObserveAgentService", () => {
  const options = { traceIdKey: "traceId" } as never;

  const createAgent = (subscribe: (...args: unknown[]) => unknown) =>
    new RpcObserveAgentService(
      new AsyncLocalStorage<Map<string, any>>(),
      options,
      { getRpcTargetRegistry: () => ({ subscribe }) } as never,
      {} as never,
      {} as never,
      {} as never,
    );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subscribes to the RPC target registry when @nestjs/microservices is installed", () => {
    const subscribe = vi.fn(() => ({ unsubscribe: vi.fn() }));
    const agent = createAgent(subscribe);

    agent.onModuleInit();

    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("stays inert when @nestjs/microservices is not installed", () => {
    vi.spyOn(
      RpcObserveAgentService.prototype as unknown as {
        loadMicroservices: () => unknown;
      },
      "loadMicroservices",
    ).mockReturnValue(undefined);
    const subscribe = vi.fn();
    const agent = createAgent(subscribe);

    expect(() => agent.onModuleInit()).not.toThrow();
    expect(subscribe).not.toHaveBeenCalled();
    expect(() => agent.onModuleDestroy()).not.toThrow();
  });

  describe("getOperationIdFromContext", () => {
    const getOperationId = (ctx: unknown): string => {
      const agent = createAgent(() => ({ unsubscribe: vi.fn() }));
      agent.onModuleInit();
      return (
        agent as unknown as {
          getOperationIdFromContext: (ctx: unknown) => string;
        }
      ).getOperationIdFromContext(ctx);
    };

    it("falls back to getPattern for a custom transport's own context class", () => {
      expect(getOperationId({ getPattern: () => "custom.pattern" })).toBe(
        "custom.pattern",
      );
    });

    it("answers 'unknown' rather than throwing when a custom context exposes no accessor", () => {
      expect(getOperationId({})).toBe("unknown");
    });
  });

  /**
   * Nest's servers hand the processing start hook's result back from their
   * message handlers, and kafkajs waits on it - committing the offset once
   * `eachMessage` resolves and retrying the message when it rejects - so the
   * hook must hand back what `done` returns rather than settle on its own.
   */
  describe("processing start hook", () => {
    const createHookedAgent = (
      overrides: {
        ignore?: boolean;
        capture?: boolean;
        throwInIgnore?: boolean;
        throwInSampling?: boolean;
      } = {},
    ) => {
      const operationTraceRegistry = {
        startTrace: vi.fn(),
        endTrace: vi.fn(),
        pluckSnapshot: vi.fn(),
      };
      const agent = new RpcObserveAgentService(
        new AsyncLocalStorage<Map<string, any>>(),
        {
          traceIdKey: "traceId",
          traceIdGenerator: () => "trace-id",
          rpc: { ignore: () => overrides.ignore ?? false },
          grpc: {
            ignore: () => {
              if (overrides.throwInIgnore) {
                throw new Error("ignore failed");
              }
              return overrides.ignore ?? false;
            },
          },
        } as never,
        {
          getRpcTargetRegistry: () => ({
            subscribe: () => ({ unsubscribe: vi.fn() }),
          }),
        } as never,
        operationTraceRegistry as never,
        {} as never,
        {
          shouldCapture: () => {
            if (overrides.throwInSampling) {
              throw new Error("sampling failed");
            }
            return overrides.capture ?? true;
          },
        } as never,
      );
      agent.onModuleInit();
      return { agent, operationTraceRegistry };
    };

    const captureStartHook = (agent: ReturnType<typeof createHookedAgent>) => {
      let startHook!: (
        transportId: Transport,
        ctx: unknown,
        done: () => Promise<unknown>,
      ) => unknown;
      agent.agent.registerRpcHooks({
        setOnProcessingStartHook: (hook: typeof startHook) => {
          startHook = hook;
        },
        setOnProcessingEndHook: vi.fn(),
      } as never);
      return startHook;
    };

    describe.each([
      ["an RPC message", Transport.TCP],
      ["a gRPC call", Transport.GRPC],
    ])("for %s", (_transport, transportId) => {
      it.each([
        ["traced", {}],
        ["ignored", { ignore: true }],
        ["sampled out", { capture: false }],
      ])(
        "returns what done returns when the operation is %s",
        async (_operation, overrides) => {
          const { agent, operationTraceRegistry } =
            createHookedAgent(overrides);
          const startHook = captureStartHook({ agent, operationTraceRegistry });
          const error = new Error("handler failed");
          const done = vi
            .fn<() => Promise<unknown>>()
            .mockResolvedValueOnce("handled")
            .mockRejectedValueOnce(error);

          await expect(
            Promise.resolve(startHook(transportId, {}, done)),
          ).resolves.toBe("handled");
          await expect(
            Promise.resolve(startHook(transportId, {}, done)),
          ).rejects.toBe(error);
          // gRPC calls done from a timer; let it fire so an extra call counts.
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(done).toHaveBeenCalledTimes(2);
          expect(operationTraceRegistry.startTrace).toHaveBeenCalledTimes(
            _operation === "traced" ? 2 : 0,
          );
        },
      );
    });

    it("lets a Kafka consumer see an event handler's failure", async () => {
      const server = new ServerKafka({});
      createHookedAgent().agent.registerRpcHooks(server as never);
      const error = new Error("handler failed");
      server.addHandler(
        "orders",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw error;
        },
        true,
      );

      await expect(
        server.getMessageHandler()({
          topic: "orders",
          partition: 0,
          message: { value: Buffer.from("{}"), headers: {} },
          heartbeat: async () => undefined,
        } as never),
      ).rejects.toBe(error);
    });

    it.each([
      ["ignore", { throwInIgnore: true }],
      ["sampling", { throwInSampling: true }],
    ] as const)(
      "runs the gRPC handler once without a trace when the %s decision throws",
      async (_decision, overrides) => {
        const { agent, operationTraceRegistry } = createHookedAgent(overrides);
        const logger = (agent as unknown as { logger: { warn: () => void } })
          .logger;
        const warn = vi
          .spyOn(logger, "warn")
          .mockImplementation(() => {
            throw new Error("logger failed");
          });
        const startHook = captureStartHook({ agent, operationTraceRegistry });
        const businessError = new Error("business error");
        const done = vi
          .fn<() => Promise<unknown>>()
          .mockRejectedValue(businessError);

        for (let index = 0; index < 2; index++) {
          await expect(
            Promise.resolve(startHook(Transport.GRPC, {}, done)),
          ).rejects.toBe(businessError);
        }

        expect(done).toHaveBeenCalledTimes(2);
        expect(operationTraceRegistry.startTrace).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
      },
    );
  });
});
