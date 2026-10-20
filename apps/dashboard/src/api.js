import { useEffect, useRef, useState } from 'react';

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

const MAX_ROWS = 400;

// Live state: initial message list over REST, then updates over the WebSocket.
export function useLive() {
  const [stats, setStats] = useState(null);
  const [rows, setRows] = useState(new Map());
  const [connected, setConnected] = useState(false);
  const retry = useRef(0);

  useEffect(() => {
    let ws;
    let closed = false;
    let timer;

    const upsert = (row) =>
      setRows((prev) => {
        const next = new Map(prev);
        next.set(row.control_id, row);
        if (next.size > MAX_ROWS) {
          const at = (r) => r.received_at ?? r.updated_at;
          const oldest = [...next.values()].sort((a, b) => at(a).localeCompare(at(b)))[0];
          next.delete(oldest.control_id);
        }
        return next;
      });

    const open = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = async () => {
        retry.current = 0;
        setConnected(true);
        const list = await api(`/api/messages?limit=${MAX_ROWS}`).catch(() => []);
        setRows(new Map(list.map((r) => [r.control_id, r])));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'stats') setStats(msg.stats);
        if (msg.type === 'message') upsert(msg.row);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = setTimeout(open, Math.min(1000 * 2 ** retry.current++, 8000));
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, []);

  // Newest arrival first; control IDs break ties for messages received in the same millisecond.
  const arrival = (r) => r.received_at ?? r.updated_at;
  const sorted = [...rows.values()].sort((a, b) => arrival(b).localeCompare(arrival(a)) || b.control_id.localeCompare(a.control_id));
  return { stats, rows: sorted, connected };
}

export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : '');

export function msBetween(a, b) {
  if (!a || !b) return null;
  return Math.max(0, new Date(b) - new Date(a));
}

export const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
