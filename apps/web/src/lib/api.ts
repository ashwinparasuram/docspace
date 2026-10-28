export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

type Body = Record<string, unknown> | unknown[] | FormData | undefined;

async function request<T>(method: string, url: string, body?: Body): Promise<T> {
  const headers: Record<string, string> = { 'x-requested-with': 'docspace' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${url}`, { method, headers, body: payload, credentials: 'same-origin' });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const message = (data && typeof data === 'object' && (data as any).error) || res.statusText || 'Request failed';
    const err = new ApiError(res.status, message, data && typeof data === 'object' ? (data as any).details ?? data : undefined);
    if (res.status === 401 && !url.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('ds:unauthorized'));
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T = any>(url: string) => request<T>('GET', url),
  post: <T = any>(url: string, body?: Body) => request<T>('POST', url, body ?? {}),
  put: <T = any>(url: string, body?: Body) => request<T>('PUT', url, body ?? {}),
  patch: <T = any>(url: string, body?: Body) => request<T>('PATCH', url, body ?? {}),
  del: <T = any>(url: string, body?: Body) => request<T>('DELETE', url, body),
};

/** POST to a server-sent-events endpoint and stream `delta` text chunks. */
export async function streamSSE(url: string, body: unknown, onDelta: (text: string) => void, signal?: AbortSignal): Promise<{ error?: string }> {
  const res = await fetch(`/api${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'docspace' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    return { error: data.error || `Request failed (${res.status})` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let error: string | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const p of parts) {
      const line = p.replace(/^data:\s*/, '');
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'delta') onDelta(ev.text);
        else if (ev.type === 'error') error = ev.message;
      } catch {
        /* ignore */
      }
    }
  }
  return { error };
}

export async function uploadFiles(spaceId: string, files: File[]): Promise<{ id: string; url: string; filename: string; mime: string; size: number }[]> {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  return api.post(`/spaces/${spaceId}/files`, fd);
}
