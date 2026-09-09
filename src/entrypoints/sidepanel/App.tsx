import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Copy, Database, RefreshCw, Trash2 } from 'lucide-react';
import type { Capture, MessageBody, MessageHeaders } from '@/capture/capture';
import { base64ToBytes } from '@/capture/bytes';
import { loadDebugUiConfig } from '@/config/config-projection-store';
import { createCaptureStore, type CapacityStatus, type CaptureCleaner, type CaptureReader, type CaptureSummary, type InteractionSummary } from '@/storage/capture-store';
import { clearDiagnostics, loadDiagnostics, type DiagnosticRecord } from '@/storage/diagnostic-store';
import { decodeBodyText } from './body-text';

const store: CaptureReader & CaptureCleaner = createCaptureStore({
  config: () => ({
    revision: 'sidepanel', warningBytes: 384 * 1024 * 1024,
    hardLimitBytes: 512 * 1024 * 1024, draftTtlMs: 86_400_000,
  }),
});

type DetailTab = 'overview' | 'headers' | 'body';
type BodyView = 'hex' | 'base64' | 'text';

export default function App() {
  const [interactions, setInteractions] = useState<InteractionSummary[]>([]);
  const [selectedInteraction, setSelectedInteraction] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<CaptureSummary[]>([]);
  const [selectedCapture, setSelectedCapture] = useState<Capture | null>(null);
  const [capacity, setCapacity] = useState<CapacityStatus | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');
  const [defaultBodyView, setDefaultBodyView] = useState<BodyView>('text');
  const [bodyView, setBodyView] = useState<BodyView>('text');
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticRecord[]>([]);
  const [clearing, setClearing] = useState(false);
  const selectedInteractionCaptureCount = interactions.find((interaction) => interaction.id === selectedInteraction)?.captureCount ?? 0;

  const refresh = async (pageSize = 100) => {
    try {
      const [page, status, recentDiagnostics] = await Promise.all([
        store.listInteractions({ limit: pageSize }), store.getCapacityStatus(), loadDiagnostics(3),
      ]);
      setInteractions(page.items);
      setCapacity(status);
      setDiagnostics(recentDiagnostics);
      setSelectedInteraction((current) => current ?? page.items[0]?.id ?? null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    void loadDebugUiConfig().then((config) => {
      if (stopped) return;
      const pageSize = config?.pageSize ?? 100;
      if (config) {
        setDefaultBodyView(config.defaultBodyView);
        setBodyView(config.defaultBodyView);
      }
      void refresh(pageSize);
      timer = setInterval(() => void refresh(pageSize), config?.refreshIntervalMs ?? 2_000);
    });
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    if (!selectedInteraction) {
      setSummaries([]);
      setSelectedCapture(null);
      return;
    }
    void (async () => {
      const items = await store.listCaptures({ interactionId: selectedInteraction });
      if (stopped) return;
      setSummaries(items);
      if (selectedCapture && items.some((item) => item.id === selectedCapture.id)) return;
      const first = items[0] ? await store.getById(items[0].id) : null;
      if (stopped) return;
      setSelectedCapture(first);
      setBodyView(defaultBodyView);
      setDetailTab('overview');
    })().catch((reason) => {
      if (!stopped) setError(String(reason));
    });
    return () => { stopped = true; };
  }, [selectedInteraction, selectedInteractionCaptureCount, selectedCapture?.id, defaultBodyView]);

  const selectCapture = async (id: string) => {
    const capture = await store.getById(id);
    setSelectedCapture(capture);
    setBodyView(defaultBodyView);
    setDetailTab('overview');
  };

  const clearStoredData = async () => {
    if (!window.confirm('Clear all captured data? This cannot be undone.')) return;
    setClearing(true);
    try {
      await Promise.all([store.clear(), clearDiagnostics()]);
      setInteractions([]);
      setSelectedInteraction(null);
      setSummaries([]);
      setSelectedCapture(null);
      setDiagnostics([]);
      setCapacity(await store.getCapacityStatus());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setClearing(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Network Capture</h1>
          <p>HTTP · SSE · WebSocket</p>
        </div>
        <div className="topbar-actions">
          {capacity && <CapacityBadge status={capacity} />}
          <button className="icon-button danger-button" title="Clear all captured data" aria-label="Clear all captured data" disabled={clearing} onClick={() => void clearStoredData()}>
            <Trash2 size={16} />
          </button>
          <button className="icon-button" title="Refresh captures" onClick={() => void refresh()}>
            <RefreshCw size={16} />
          </button>
        </div>
      </header>

      {error && <div className="error-banner"><AlertTriangle size={15} />{error}</div>}
      {diagnostics.length > 0 && (
        <div className="diagnostics" aria-label="Recent diagnostics">
          {diagnostics.map((diagnostic) => (
            <div key={diagnostic.id} className={`diagnostic diagnostic-${diagnostic.level}`}>
              <AlertTriangle size={13} />
              <strong>{diagnostic.area}</strong>
              <span>{diagnostic.message}</span>
              <time>{formatTime(diagnostic.occurredAt)}</time>
            </div>
          ))}
        </div>
      )}

      <div className="workspace">
        <aside className="interaction-pane">
          {interactions.length === 0 ? (
            <div className="empty-state"><Database size={28} /><strong>No captures</strong><span>Waiting for completed network records</span></div>
          ) : interactions.map((interaction) => (
            <button
              key={interaction.id}
              className={`interaction-row ${selectedInteraction === interaction.id ? 'selected' : ''}`}
              onClick={() => setSelectedInteraction(interaction.id)}
            >
              <span className={`protocol protocol-${interaction.protocol}`}>{interaction.protocol}</span>
              <strong>{safeUrl(interaction.url)}</strong>
              <small>{interaction.captureCount} records · {formatTime(interaction.capturedAt)}</small>
            </button>
          ))}
        </aside>

        <section className="capture-pane">
          <nav className="capture-strip">
            {summaries.map((summary) => (
              <button
                key={summary.id}
                className={selectedCapture?.id === summary.id ? 'selected' : ''}
                onClick={() => void selectCapture(summary.id)}
              >
                <KindIcon capture={summary} />
                <span>{kindLabel(summary.kind)}</span>
                {summary.byteLength !== null && <small>{formatBytes(summary.byteLength)}</small>}
              </button>
            ))}
          </nav>

          {!selectedCapture ? <div className="empty-detail">Select a capture record</div> : (
            <div className="detail">
              <div className="detail-heading">
                <div><span className="kind-chip">{selectedCapture.kind}</span><h2>{safeUrl(selectedCapture.url)}</h2></div>
                <time>{new Date(selectedCapture.capturedAt).toLocaleString()}</time>
              </div>
              {isLossy(selectedCapture) && (
                <div className="warning"><AlertTriangle size={14} />This record contains browser API projections; unavailable fields are not reconstructed.</div>
              )}
              <div className="tabs">
                {(['overview', 'headers', 'body'] as const).map((tab) => (
                  <button key={tab} className={detailTab === tab ? 'active' : ''} onClick={() => setDetailTab(tab)}>{tab}</button>
                ))}
              </div>
              {detailTab === 'overview' && <Overview capture={selectedCapture} />}
              {detailTab === 'headers' && <HeadersView headers={headersOf(selectedCapture)} />}
              {detailTab === 'body' && (
                <BodyPanel capture={selectedCapture} body={bodyOf(selectedCapture)} view={bodyView} setView={setBodyView} />
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function CapacityBadge({ status }: { status: CapacityStatus }) {
  return <div className={`capacity capacity-${status.level}`}><Database size={13} />{formatBytes(status.logicalBytes)} / {formatBytes(status.hardLimitBytes)}</div>;
}

function KindIcon({ capture }: { capture: CaptureSummary }) {
  if (capture.kind === 'websocket-message') return capture.direction === 'outbound' ? <ArrowUpRight size={13} /> : <ArrowDownLeft size={13} />;
  if (capture.kind === 'http-request') return <ArrowUpRight size={13} />;
  return <span className="event-dot" />;
}

function Overview({ capture }: { capture: Capture }) {
  const rows: Array<[string, string]> = [
    ['URL', capture.url], ['Page', capture.pageUrl], ['Rule', capture.matchedRuleId],
    ['Config revision', capture.configRevision], ['Capture ID', capture.id],
  ];
  if ('exchangeId' in capture && capture.exchangeId) rows.push(['Exchange ID', capture.exchangeId]);
  if ('streamId' in capture) rows.push(['Stream ID', capture.streamId], ['Fidelity', capture.fidelity]);
  if ('connectionId' in capture) rows.push(['Connection ID', capture.connectionId]);
  if (capture.kind === 'http-request') rows.push(['Method', capture.method]);
  if (capture.kind === 'http-response') rows.push(['Status', `${capture.status} ${capture.statusText}`]);
  if ('transport' in capture) rows.push(['Transport', capture.transport], ['HTTP version', `${capture.httpVersion.value} (${capture.httpVersion.source})`]);
  if ('attempt' in capture) rows.push(['Attempt', String(capture.attempt)]);
  if (capture.kind === 'sse-stream-open') rows.push(['Status', observationText(capture.status)], ['HTTP version', `${capture.httpVersion.value} (${capture.httpVersion.source})`]);
  if (capture.kind === 'websocket-message') rows.push(['Direction', capture.direction], ['Sequence', String(capture.sequence)]);
  if (capture.kind === 'sse-event') rows.push(['Sequence', String(capture.sequence)], ['Event type', capture.eventType ?? 'unavailable']);
  if (capture.kind === 'sse-stream-close') rows.push(['Outcome', capture.outcome], ['Events', String(capture.eventCount)], ['Captured bytes', String(capture.capturedByteLength)]);
  if (capture.kind === 'websocket-open') rows.push(['Requested protocols', capture.requestedProtocols.join(', ') || 'none'], ['Negotiated protocol', capture.negotiatedProtocol || 'none'], ['Extensions', capture.extensions || 'none'], ['Handshake', `unavailable: ${capture.handshake.reason}`]);
  if (capture.kind === 'websocket-close') rows.push(['Close', `${capture.code} · ${capture.wasClean ? 'clean' : 'unclean'}`], ['Messages sent', String(capture.sentMessageCount)], ['Messages received', String(capture.receivedMessageCount)]);
  if (capture.kind.endsWith('error')) rows.push(['Error', 'reason' in capture ? String(capture.reason ?? 'unknown') : 'unknown']);
  return <dl className="metadata">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function HeadersView({ headers }: { headers: MessageHeaders | null }) {
  if (!headers) return <div className="state-box">Headers do not apply to this record.</div>;
  if (headers.state === 'unavailable') return <div className="state-box warning">Unavailable: {headers.reason}</div>;
  if (headers.entries.length === 0) return <div className="state-box">No script-visible headers.</div>;
  return <div className="headers-view"><button className="icon-button copy-button" title="Copy headers" onClick={() => void copyText(headers.entries.map(([name, value]) => `${name}: ${value}`).join('\n'))}><Copy size={14} /></button><div className="headers-table">{headers.entries.map(([name, value], index) => <div key={`${name}-${index}`}><code>{name}</code><span>{value}</span></div>)}</div></div>;
}

function BodyPanel({ capture, body, view, setView }: { capture: Capture; body: MessageBody | null; view: BodyView; setView(value: BodyView): void }) {
  if (!body) return <div className="state-box">Body does not apply to this record.</div>;
  if (body.state === 'absent') return <div className="state-box">Body absent.</div>;
  if (body.state === 'unavailable') return <div className="state-box warning">Unavailable: {body.reason}{body.partialByteLength ? ` · ${formatBytes(body.partialByteLength)} observed` : ''}</div>;
  const bytes = base64ToBytes(body.data);
  const rendered = view === 'base64' ? body.data : view === 'text' ? decodeText(capture, bytes) : toHex(bytes);
  return <div className="body-panel">
    <div className="body-toolbar"><span>{formatBytes(body.byteLength)}{body.fidelity === 'decoded-text-projection' ? ' · decoded text projection' : ''}</span><div>{(['hex', 'base64', 'text'] as const).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{item}</button>)}<button className="icon-button" title="Copy body" onClick={() => void copyText(rendered)}><Copy size={14} /></button></div></div>
    <pre>{rendered}</pre>
  </div>;
}

function headersOf(capture: Capture): MessageHeaders | null {
  return 'headers' in capture ? capture.headers : null;
}

function bodyOf(capture: Capture): MessageBody | null {
  return 'body' in capture ? capture.body : null;
}

function isLossy(capture: Capture): boolean {
  return ('fidelity' in capture && capture.fidelity !== 'raw-event-bytes') ||
    capture.kind.startsWith('websocket-');
}

function safeUrl(value: string): string {
  try { const url = new URL(value); return `${url.host}${url.pathname}`; } catch { return value; }
}

function kindLabel(kind: Capture['kind']): string {
  return kind.replace('websocket-', 'ws ').replace('sse-stream-', 'stream ').replace('sse-', '').replace('http-', '');
}

function formatTime(value: number): string { return new Date(value).toLocaleTimeString(); }
function formatBytes(value: number): string { return value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`; }
function toHex(bytes: Uint8Array): string { return Array.from(bytes, (byte, index) => `${index % 16 === 0 ? `${index.toString(16).padStart(8, '0')}  ` : ''}${byte.toString(16).padStart(2, '0')}${index % 16 === 15 ? '\n' : ' '}`).join(''); }

function observationText(value: { state: 'observed'; value: number } | { state: 'unavailable'; reason: string }): string {
  return value.state === 'observed' ? String(value.value) : `unavailable: ${value.reason}`;
}

function decodeText(capture: Capture, bytes: Uint8Array): string {
  const headers = headersOf(capture);
  const contentType = headers?.state === 'captured' ? headers.entries.find(([name]) => name.toLowerCase() === 'content-type')?.[1] : undefined;
  return decodeBodyText(bytes, contentType) ?? toHex(bytes);
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}