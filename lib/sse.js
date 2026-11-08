const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export function createSseHub({
  heartbeatMs = 20_000,
  maxClients = 50,
  maxBuffered = 4 * 1024 * 1024,
  logger = console,
  onAttach,
  onDetach,
  onHeartbeat,
} = {}) {
  const clients = new Set();

  // Single exit path so onDetach fires exactly once per client.
  function removeClient(client) {
    if (!clients.has(client)) return;
    clients.delete(client);
    if (client.identity) onDetach?.(client);
  }

  const heartbeat = setInterval(() => {
    for (const client of [...clients]) {
      if (client.res.writableEnded) {
        removeClient(client);
        continue;
      }
      if (client.res.writableLength > maxBuffered) {
        logger?.warn?.("dropping slow SSE client");
        client.res.destroy();
        removeClient(client);
        continue;
      }
      try {
        client.res.write(": ping\n\n");
        if (client.identity) onHeartbeat?.(client);
      } catch {
        removeClient(client);
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  function matches(client, message) {
    const topicOk = !client.topic || client.topic === "all" || message.topic === client.topic;
    const toOk = !client.to || message.to === "all" || message.to === client.to;
    return topicOk && toOk;
  }

  function writeEvent(client, message) {
    if (client.res.writableEnded) {
      removeClient(client);
      return;
    }
    if (client.res.writableLength > maxBuffered) {
      client.res.destroy();
      removeClient(client);
      return;
    }
    try {
      client.res.write(`id: ${message.id}\ndata: ${JSON.stringify(message)}\n\n`);
    } catch {
      removeClient(client);
    }
  }

  function add(req, res, { topic = "all", to = null, replay = [], identity = null } = {}) {
    if (clients.size >= maxClients) return false;

    res.writeHead(200, SSE_HEADERS);
    res.flushHeaders?.();
    res.write("retry: 3000\n\n");

    const client = { res, topic, to, identity };
    for (const message of replay) {
      if (res.writableEnded) return true;
      writeEvent(client, message);
    }

    if (!res.writableEnded) {
      clients.add(client);
      if (identity) onAttach?.(client);
      res.on("close", () => removeClient(client));
    }
    return true;
  }

  function broadcast(message) {
    for (const client of [...clients]) {
      if (matches(client, message)) writeEvent(client, message);
    }
  }

  function close() {
    clearInterval(heartbeat);
    for (const client of [...clients]) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
  }

  return {
    add,
    broadcast,
    close,
    get size() {
      return clients.size;
    },
  };
}
