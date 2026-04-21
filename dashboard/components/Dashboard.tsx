'use client';

/**
 * Dashboard.tsx — Live Translation Real-Time Latency Dashboard
 *
 * Connects to ws://localhost:8080?client=dashboard and displays live stats
 * as the extension processes audio chunks. Auto-reconnects every 3 seconds
 * if the connection drops.
 *
 * Stats shown:
 *   - Total chunks processed
 *   - Average total round-trip latency
 *   - Average server processing time
 *   - Latest chunk latency breakdown (horizontal bars)
 *   - Line chart of last 50 chunks
 *   - Scrollable raw log table
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChunkStat {
  chunkId:          number;
  t1:               number;
  t2:               number;
  t3:               number;
  networkIn:        number;  // t2 - t1  (extension → server)
  processing:       number;  // t3 - t2  (server processing)
  networkOut?:      number;  // t4 - t3  (server → extension, approximated client-side)
  total?:           number;  // t4 - t1  (full round-trip, approximated)
  processingFailed?: boolean;
  receivedAt:       number;  // Date.now() when dashboard received the stat
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function latencyColor(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '#6b7280';
  if (ms < 100)  return '#22c55e';
  if (ms < 300)  return '#f59e0b';
  return '#ef4444';
}

function latencyLabel(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '--';
  return `${ms}ms`;
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface StatCardProps {
  label:     string;
  value:     string;
  sub?:      string;
  color?:    string;
}

function StatCard({ label, value, sub, color }: StatCardProps) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 flex flex-col gap-1">
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">{label}</p>
      <p className="text-2xl font-bold" style={{ color: color ?? '#e2e8f0' }}>{value}</p>
      {sub && <p className="text-xs text-gray-600">{sub}</p>}
    </div>
  );
}

interface LatencyBarProps {
  label:  string;
  ms:     number | undefined;
  maxMs:  number;
}

function LatencyBar({ label, ms, maxMs }: LatencyBarProps) {
  const pct    = ms !== undefined ? Math.min((ms / Math.max(maxMs, 1)) * 100, 100) : 0;
  const color  = latencyColor(ms);

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-400 w-36 shrink-0">{label}</span>
      <div className="flex-1 bg-gray-800 rounded-full h-2.5 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="text-xs font-semibold tabular-nums w-14 text-right" style={{ color }}>
        {latencyLabel(ms)}
      </span>
    </div>
  );
}

// ─── Custom Recharts Tooltip ──────────────────────────────────────────────────

interface TooltipPayloadItem {
  name: string;
  value: number;
  stroke: string;
}

interface CustomTooltipProps {
  active?:  boolean;
  payload?: TooltipPayloadItem[];
  label?:   string | number;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs shadow-xl">
      <p className="text-gray-400 mb-1">Chunk #{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.stroke }}>
          {p.name}: <strong>{p.value}ms</strong>
        </p>
      ))}
    </div>
  );
}

// ─── Main Dashboard Component ─────────────────────────────────────────────────

export default function Dashboard() {
  const [connected,         setConnected]         = useState(false);
  const [chunks,            setChunks]            = useState<ChunkStat[]>([]);
  const [totalProcessed,    setTotalProcessed]    = useState(0);
  const [averageLatency,    setAverageLatency]    = useState(0);
  const [averageProcessing, setAverageProcessing] = useState(0);

  const wsRef          = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── WebSocket connection / reconnect ────────────────────────────────────────

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState < 2 /* OPEN or CONNECTING */) return;

    console.log('[Dashboard] Connecting to ws://localhost:8080?client=dashboard');
    const ws = new WebSocket('ws://localhost:8080?client=dashboard');
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[Dashboard] WebSocket connected');
      setConnected(true);
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };

    ws.onmessage = (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data as string);
      } catch (err) {
        console.error('[Dashboard] Failed to parse message:', err);
        return;
      }

      if (message.type === 'chunkStats') {
        const stat: ChunkStat = {
          chunkId:          message.chunkId as number,
          t1:               message.t1 as number,
          t2:               message.t2 as number,
          t3:               message.t3 as number,
          networkIn:        message.networkIn as number,
          processing:       message.processing as number,
          processingFailed: message.processingFailed as boolean | undefined,
          receivedAt:       Date.now(),
        };

        // We don't have t4 on the server side — approximate total as networkIn + processing
        // The extension sends back the actual total via the popup. For the dashboard we show
        // what we know from the server: inbound network + processing time.
        stat.total = stat.networkIn + stat.processing;

        setChunks((prev) => {
          const next = [...prev, stat].slice(-50); // Keep last 50
          // Recompute averages
          const totals    = next.map((c) => c.total ?? 0).filter(Boolean);
          const procs     = next.map((c) => c.processing);
          setAverageLatency(avg(totals));
          setAverageProcessing(avg(procs));
          return next;
        });

        setTotalProcessed((n) => n + 1);
        console.log(`[Dashboard] Chunk ${stat.chunkId}: net-in=${stat.networkIn}ms proc=${stat.processing}ms`);
      }
    };

    ws.onclose = () => {
      console.log('[Dashboard] WebSocket disconnected — will retry in 3s');
      setConnected(false);
      wsRef.current = null;
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = (err) => {
      console.error('[Dashboard] WebSocket error:', err);
      // onclose will fire after onerror
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);

  // ── Derived data ────────────────────────────────────────────────────────────

  const lastChunk      = chunks[chunks.length - 1];
  const chartData      = chunks.map((c) => ({
    name:       c.chunkId,
    'Net In':   c.networkIn,
    'Proc':     c.processing,
    'Total':    c.total ?? 0,
  }));

  // Max ms for the latest chunk bar display
  const barMax = lastChunk ? Math.max(lastChunk.networkIn + lastChunk.processing + 50, 200) : 500;

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-6 font-sans">

      {/* ── Header ── */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-purple-400 tracking-tight">
            ⚡ Live Translation
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">Developer Dashboard — Real-time latency monitor</p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="w-3 h-3 rounded-full"
            style={{
              background:  connected ? '#22c55e' : '#ef4444',
              boxShadow:   connected ? '0 0 8px #22c55e88' : '0 0 8px #ef444488',
            }}
          />
          <span
            className="text-sm font-semibold"
            style={{ color: connected ? '#22c55e' : '#ef4444' }}
          >
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      {/* ── Stat Cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Total Chunks"
          value={totalProcessed.toString()}
          sub="processed since load"
        />
        <StatCard
          label="Avg Total Latency"
          value={averageLatency ? `${averageLatency}ms` : '--'}
          sub="net-in + processing"
          color={latencyColor(averageLatency || null)}
        />
        <StatCard
          label="Avg Processing"
          value={averageProcessing ? `${averageProcessing}ms` : '--'}
          sub="ffmpeg per chunk"
          color={latencyColor(averageProcessing || null)}
        />
        <StatCard
          label="Last Chunk Total"
          value={lastChunk ? `${lastChunk.total}ms` : '--'}
          sub={lastChunk ? `chunk #${lastChunk.chunkId}` : 'no data yet'}
          color={latencyColor(lastChunk?.total)}
        />
      </div>

      {/* ── Latest Chunk Breakdown ── */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 mb-8">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-500 mb-4">
          Latest Chunk Breakdown
        </h2>
        {lastChunk ? (
          <div className="flex flex-col gap-3">
            <LatencyBar label="Extension → Server"  ms={lastChunk.networkIn}  maxMs={barMax} />
            <LatencyBar label="Server Processing"   ms={lastChunk.processing} maxMs={barMax} />
            <LatencyBar label="Approx Total"        ms={lastChunk.total}      maxMs={barMax} />
            {lastChunk.processingFailed && (
              <p className="text-xs text-red-400 mt-1">
                ⚠ ffmpeg failed on this chunk — original audio was returned unmodified
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-600">
            No chunks received yet. Make sure the server is running and the extension is active on a Meet call.
          </p>
        )}
      </div>

      {/* ── Line Chart ── */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 mb-8">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-500 mb-4">
          Latency Over Last {chunks.length} Chunks
        </h2>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="name"
                tick={{ fill: '#6b7280', fontSize: 11 }}
                label={{ value: 'Chunk #', position: 'insideBottom', offset: -2, fill: '#4b5563', fontSize: 11 }}
              />
              <YAxis
                tick={{ fill: '#6b7280', fontSize: 11 }}
                unit="ms"
                tickCount={5}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: '12px', paddingTop: '8px' }}
                formatter={(v) => <span style={{ color: '#9ca3af' }}>{v}</span>}
              />
              {/* Reference lines */}
              <ReferenceLine y={100} stroke="#22c55e" strokeDasharray="4 4" label={{ value: '100ms', fill: '#22c55e', fontSize: 10 }} />
              <ReferenceLine y={300} stroke="#ef4444" strokeDasharray="4 4" label={{ value: '300ms', fill: '#ef4444', fontSize: 10 }} />
              {/* Data lines */}
              <Line type="monotone" dataKey="Net In"  stroke="#38bdf8" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="Proc"    stroke="#a78bfa" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="Total"   stroke="#fbbf24" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Raw Log Table ── */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-gray-500 mb-4">
          Raw Log — Last 20 Chunks
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-2 pr-4 font-semibold">Chunk</th>
                <th className="text-right py-2 pr-4 font-semibold">Net In</th>
                <th className="text-right py-2 pr-4 font-semibold">Processing</th>
                <th className="text-right py-2 pr-4 font-semibold">~Total</th>
                <th className="text-right py-2 pr-4 font-semibold">t1</th>
                <th className="text-right py-2 pr-4 font-semibold">t2</th>
                <th className="text-right py-2 font-semibold">t3</th>
              </tr>
            </thead>
            <tbody>
              {chunks.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-gray-600 py-8">
                    Waiting for data…
                  </td>
                </tr>
              ) : (
                [...chunks].reverse().slice(0, 20).map((c) => (
                  <tr key={c.chunkId} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="py-1.5 pr-4 text-gray-400">#{c.chunkId}</td>
                    <td className="py-1.5 pr-4 text-right tabular-nums" style={{ color: latencyColor(c.networkIn) }}>
                      {c.networkIn}ms
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums" style={{ color: latencyColor(c.processing) }}>
                      {c.processing}ms
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums font-semibold" style={{ color: latencyColor(c.total) }}>
                      {c.total}ms
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums text-gray-600">
                      {c.t1}
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums text-gray-600">
                      {c.t2}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-gray-600">
                      {c.t3}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Footer ── */}
      <p className="text-center text-xs text-gray-700 mt-6">
        Live Translation v1.0 — Dev Dashboard — Server: ws://localhost:8080
      </p>
    </div>
  );
}
