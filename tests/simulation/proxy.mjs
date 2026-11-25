import { createServer, request } from 'node:http';
import { connect } from 'node:net';

// A forwarding proxy to the daemon at `target`. A client (a browser, or a
// fixture client from connect()) stays on its URL; cutting its sockets leaves
// the daemon reachable by the fixture's own client, so the state can change
// while that client is offline.
export async function connectionProxy(target) {
  let online = true, disconnects = 0;
  const sockets = new Set(), tunnels = new Set();
  const [host, port] = target.split(':');
  const server = createServer((incoming, outgoing) => {
    if (!online) { outgoing.writeHead(503).end(); return; }
    const forward = request({ hostname: host, port, method: incoming.method, path: incoming.url,
      headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
    });
    forward.on('error', () => outgoing.destroy()); incoming.pipe(forward);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (!online) { socket.destroy(); return; }
    const upstream = connect(Number(port), host, () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
        Object.entries(req.headers).map(([key, value]) => `${key}: ${value}\r\n`).join('') + '\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    tunnels.add(upstream); upstream.on('close', () => tunnels.delete(upstream));
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    get disconnects() { return disconnects; },
    offline() { online = false; disconnects++; for (const socket of [...sockets, ...tunnels]) socket.destroy(); },
    online() { online = true; },
    async close() { for (const socket of [...sockets, ...tunnels]) socket.destroy(); await new Promise(done => server.close(done)); },
  };
}
