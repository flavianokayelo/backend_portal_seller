import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import app from "../../main";

function testCredentials(): { email: string; password: string } {
  const email = process.env.INTEGRATION_TEST_EMAIL;
  const password = process.env.INTEGRATION_TEST_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Defina INTEGRATION_TEST_EMAIL e INTEGRATION_TEST_PASSWORD para executar os testes de integração.",
    );
  }
  return { email, password };
}

const hasTestCredentials = Boolean(
  process.env.INTEGRATION_TEST_EMAIL && process.env.INTEGRATION_TEST_PASSWORD,
);

async function request(
  server: ReturnType<typeof createServer>,
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as AddressInfo;
    const opts: http.RequestOptions = {
      hostname: "localhost",
      port: addr.port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers });
        }
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function login(server: any) {
  const credentials = testCredentials();
  const res = await request(server, "POST", "/api/v1/auth/login", {
    email: credentials.email,
    password: credentials.password,
  });
  assert.strictEqual(res.status, 200, "login should return 200");
  const setCookie = res.headers["set-cookie"] as string[];
  const sid = setCookie![0].split(";")[0];
  return sid;
}

export { hasTestCredentials, request, login };
