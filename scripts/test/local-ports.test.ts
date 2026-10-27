import { expect, test } from 'bun:test';
import net from 'node:net';
import { assertPortFree } from '../local/compose.mjs';

test('受管端口交接仍拒绝第三方监听，且不停止占用者', async () => {
  const server = net.createServer((socket) => socket.end('occupant remains available'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address missing');
    await expect(assertPortFree(address.port, { replacingOwned: true })).rejects.toMatchObject({
      code: 'PORT_IN_USE',
    });
    const response = await new Promise<string>((resolve, reject) => {
      let content = '';
      const client = net.connect({ host: '127.0.0.1', port: address.port });
      client.once('error', reject);
      client.on('data', (chunk) => {
        content += chunk.toString();
      });
      client.once('end', () => resolve(content));
    });
    expect(response).toBe('occupant remains available');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
