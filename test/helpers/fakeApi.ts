import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { finishedRunFixture, meUserFixture } from './fixtures.js';

export interface FakeApi {
  baseUrl: string;
  close: () => Promise<void>;
  requests: string[];
}

const KNOWN_AGENT = 'bc-00000000-0000-0000-0000-000000000001';
const KNOWN_RUN = 'run-00000000-0000-0000-0000-000000000001';

/** A real HTTP server standing in for api.cursor.com, for end-to-end CLI tests. */
export async function startFakeApi(): Promise<FakeApi> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(`${req.method ?? 'GET'} ${url}`);
    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
    };

    if (req.headers.authorization !== 'Bearer contract-test-key') {
      send(401, { error: { code: 'unauthorized', message: 'bad key' } });
      return;
    }
    if (url === '/v1/me') {
      send(200, meUserFixture);
      return;
    }
    if (url === `/v1/agents/${KNOWN_AGENT}/runs/${KNOWN_RUN}`) {
      send(200, finishedRunFixture);
      return;
    }
    send(404, { error: { code: 'run_not_found', message: 'Run not found' } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

export const CONTRACT_AGENT_ID = KNOWN_AGENT;
export const CONTRACT_RUN_ID = KNOWN_RUN;
