export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const data = await response.json().catch(() => ({ error: 'Local service is unavailable. Check that the backend is running.' }));
  if (!response.ok) {
    const error = new Error(data.error || 'Request failed');
    error.status = response.status;
    throw error;
  }
  return data;
}

export function mergeMessages(existing = [], incoming = []) {
  const byId = new Map(existing.map(message => [message.id, message]));
  const ranks = { pending: 0, published: 1, received: 2, expired: 3 };
  for (const message of incoming) {
    const previous = byId.get(message.id);
    const receipts = new Map([...(previous?.receipts ?? []), ...(message.receipts ?? [])].map(r => [r.peerId, r]));
    byId.set(message.id, { ...previous, ...message,
      state: previous && ranks[previous.state] > ranks[message.state] ? previous.state : message.state,
      receipts: [...receipts.values()],
    });
  }
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}
