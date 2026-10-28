import { useEffect, useRef, useState } from 'react';
import { PenLine, Square } from 'lucide-react';
import { streamSSE } from '../lib/api';
import { Modal, Spinner } from '../components/ui';

export const AI_ACTIONS: { id: string; label: string }[] = [
  { id: 'improve', label: 'Improve writing' },
  { id: 'fix', label: 'Fix spelling & grammar' },
  { id: 'shorten', label: 'Make shorter' },
  { id: 'expand', label: 'Make longer' },
  { id: 'simplify', label: 'Simplify language' },
  { id: 'summarize', label: 'Summarize' },
  { id: 'professional', label: 'Professional tone' },
  { id: 'friendly', label: 'Friendly tone' },
  { id: 'explain', label: 'Explain this' },
  { id: 'translate', label: 'Translate…' },
  { id: 'custom', label: 'Custom instruction…' },
];

export const LANGUAGES = ['Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Dutch', 'Japanese', 'Chinese (Simplified)', 'Korean', 'Hindi', 'Arabic', 'Russian', 'Turkish', 'Polish'];

export interface AiRequest {
  action: string;
  text: string;
  context?: string;
  hasSelection: boolean;
}

export function AiDialog({ request, onClose, onApply, llm }: { request: AiRequest | null; onClose: () => void; onApply: (markdown: string, mode: 'replace' | 'insert') => void; llm: boolean }) {
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState('Spanish');
  const [prompt, setPrompt] = useState('');
  const abort = useRef<AbortController | null>(null);
  const needsInput = request && ['translate', 'custom', 'generate'].includes(request.action);

  const run = async () => {
    if (!request) return;
    setOutput('');
    setError(null);
    setBusy(true);
    abort.current = new AbortController();
    try {
      const res = await streamSSE('/ai/write', { action: request.action, text: request.text, context: request.context, language, prompt }, (t) => setOutput((o) => o + t), abort.current.signal);
      if (res.error) setError(res.error);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setOutput('');
    setError(null);
    setPrompt('');
    if (request && !['translate', 'custom', 'generate'].includes(request.action)) void run();
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const title = AI_ACTIONS.find((a) => a.id === request?.action)?.label || (request?.action === 'generate' ? 'Draft with assistant' : request?.action === 'continue' ? 'Continue writing' : 'Writing assistant');

  return (
    <Modal
      open={!!request}
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <PenLine className="h-4 w-4" /> {title}
        </span>
      }
      footer={
        <>
          {busy && (
            <button className="btn-secondary mr-auto" onClick={() => abort.current?.abort()}>
              <Square className="h-3.5 w-3.5" /> Stop
            </button>
          )}
          <button className="btn-secondary" onClick={onClose}>
            Discard
          </button>
          {output && !busy && (
            <>
              <button className="btn-secondary" onClick={() => onApply(output, 'insert')}>
                Insert below
              </button>
              {request?.hasSelection && (
                <button className="btn-primary" onClick={() => onApply(output, 'replace')}>
                  Replace selection
                </button>
              )}
              {!request?.hasSelection && (
                <button className="btn-primary" onClick={() => onApply(output, 'insert')}>
                  Insert
                </button>
              )}
            </>
          )}
        </>
      }
    >
      {!llm && <p className="mb-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-800/50 dark:text-slate-300">No language model is configured. Offline actions (fix, shorten, summarize) still work; set AI_PROVIDER in .env to enable the rest.</p>}
      {needsInput && (
        <form
          className="mb-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          {request?.action === 'translate' ? (
            <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={request?.action === 'generate' ? 'e.g. A guide to configuring SSO with Okta' : 'e.g. Turn this into a numbered list of steps'}
            />
          )}
          <button className="btn-primary flex-none" disabled={busy || (request?.action !== 'translate' && !prompt.trim())}>
            {busy ? <Spinner className="text-current" /> : <PenLine className="h-4 w-4" />} Generate
          </button>
        </form>
      )}
      {request?.hasSelection && (
        <details className="mb-3">
          <summary className="muted cursor-pointer text-xs">Selected text</summary>
          <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800">{request.text}</pre>
        </details>
      )}
      {(output || busy) && (
        <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 p-4 text-sm leading-6 dark:border-slate-700">
          {output}
          {busy && <span className="ml-0.5 inline-block h-4 w-px animate-pulse bg-slate-500 align-middle" />}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Modal>
  );
}
