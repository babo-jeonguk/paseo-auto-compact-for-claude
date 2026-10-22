import { createServer } from 'node:http';
import { once } from 'node:events';

// Only the external model is simulated. Paseo, Claude, the installed plugin,
// native transcripts and the automatic timer remain real.
export async function startModel() {
  let ttl = '1h', nextGate, count = 0;
  const held = new Set();
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      if (req.url.includes('count_tokens')) {
        res.setHeader('Content-Type', 'application/json'); res.end('{"input_tokens":100}'); return;
      }
      if (!req.url.startsWith('/v1/messages')) { res.writeHead(404).end(); return; }
      const body = JSON.parse(text);
      const id = ++count, mode = ttl;
      // Keep test diagnostics metadata-only, even though all inputs are synthetic.
      const entry = { id, ttl: mode, answered: false, cancelled: false };
      requests.push(entry);
      res.on('close', () => { if (!entry.answered) entry.cancelled = true; });
      if (nextGate) {
        const gate = nextGate; nextGate = null;
        gate.requestId = id; gate.arrived(id);
        await gate.wait; held.delete(gate);
      }
      if (res.destroyed) return;
      entry.answered = true;
      const five = mode === '5m' ? 10 : mode === 'mixed' ? 5 : 0;
      const hour = mode === '1h' ? 10 : mode === 'mixed' ? 5 : 0;
      const usage = { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 499_890,
        cache_creation_input_tokens: five + hour,
        ...(mode === 'missing' ? {} : { cache_creation: { ephemeral_5m_input_tokens: five, ephemeral_1h_input_tokens: hour } }) };
      const events = [
        { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant',
          model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `SIMULATION_REPLY_${id}: synthetic summary; no tools or files changed.` } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 18 } },
        { type: 'message_stop' },
      ];
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    } catch (error) { res.writeHead(500).end(String(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests,
    get count() { return count; },
    setTtl(value) { ttl = value; },
    holdNext() {
      if (nextGate) throw new Error('A request gate is already armed');
      let arrived, release;
      const gate = { arrival: new Promise(resolve => { arrived = resolve; }),
        wait: new Promise(resolve => { release = resolve; }), release, arrived, requestId: null };
      held.add(gate); nextGate = gate; return gate;
    },
    async close() {
      for (const gate of held) gate.release();
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}
