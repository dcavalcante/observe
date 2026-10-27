import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";

const childScript = fileURLToPath(
  new URL("../testing/deferred-trace-child.mjs", import.meta.url),
);

async function runChild(throws: boolean) {
  const child = spawn(process.execPath, [childScript], {
    env: { ...process.env, THROW_USER_ID: throws ? "1" : "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout
    .setEncoding("utf8")
    .on("data", (chunk: string) => (stdout += chunk));
  child.stderr
    .setEncoding("utf8")
    .on("data", (chunk: string) => (stderr += chunk));
  await vi.waitFor(() => expect(stdout).toMatch(/READY \d+/), {
    timeout: 10_000,
  });
  const port = Number(stdout.match(/READY (\d+)/)![1]);
  const request = () =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = createConnection({ host: "127.0.0.1", port }, () => {
        req.write(
          "GET /unauthenticated HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
      });
      let data = "";
      req.setEncoding("utf8").on("data", (chunk) => (data += chunk));
      req.on("end", () =>
        resolve({
          status: Number(data.match(/HTTP\/1\.1 (\d+)/)?.[1]),
          body: data.split("\r\n\r\n")[1] ?? "",
        }),
      );
      req.on("error", reject);
    });
  const response = await request();
  if (throws) await request();
  const [code, signal] = (await once(child, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  return { response, code, signal, stdout, stderr };
}

describe("deferred trace completion", () => {
  it("survives a throwing getUserId callback and still delivers both traces", async () => {
    const result = await runChild(true);
    expect(result.response.status).toBe(200);
    expect(result.response.body).toContain('"ok":true');
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain(
      'RESULT {"callbackCalls":2,"delivered":[null,null]}',
    );
    expect(result.stderr).not.toContain("getUserId exploded\n");
  }, 15_000);

  it("preserves the user id from a successful callback", async () => {
    const result = await runChild(false);
    expect(result.response.status).toBe(200);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'RESULT {"callbackCalls":1,"delivered":["user-123"]}',
    );
  }, 15_000);
});
