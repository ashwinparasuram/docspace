import { json, query } from '../db.js';
import { cosine, embed, embedModelName, localEmbed, LOCAL_EMBED_MODEL, tokenize } from '../ai/provider.js';
import { getSiteData } from '../site/data.js';

export interface SearchHit {
  pageStableId: string;
  title: string;
  path: string;
  heading: string | null;
  anchor: string | null;
  snippet: string;
  text: string;
  score: number;
}

interface ChunkRow {
  id: string;
  page_stable_id: string;
  heading: string | null;
  anchor: string | null;
  text: string;
  embedding?: string;
  embed_model?: string;
}

const vectorCache = new Map<string, { at: number; rows: (ChunkRow & { vec: number[] })[] }>();

async function loadVectors(spaceId: string, version: number) {
  const key = `${spaceId}:${version}`;
  const hit = vectorCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.rows;
  const rows = await query<ChunkRow>('SELECT id, page_stable_id, heading, anchor, text, embedding, embed_model FROM page_chunks WHERE space_id=?', [spaceId]);
  const parsed = rows.map((r) => ({ ...r, vec: json<number[]>(r.embedding, []) }));
  for (const k of vectorCache.keys()) if (k.startsWith(spaceId + ':')) vectorCache.delete(k);
  vectorCache.set(key, { at: Date.now(), rows: parsed });
  return parsed;
}

function makeSnippet(text: string, q: string): string {
  const terms = tokenize(q);
  const lower = text.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    idx = lower.indexOf(t);
    if (idx >= 0) break;
  }
  const start = Math.max(0, idx - 60);
  const s = text.slice(start, start + 220).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + s + (start + 220 < text.length ? '…' : '');
}

/**
 * Hybrid search over published (main-branch) content: MySQL full-text + vector similarity,
 * fused with Reciprocal Rank Fusion. Returns at most one hit per page section.
 */
export async function searchSpace(space: { id: string; content_version: number }, q: string, limit = 10, mode: 'hybrid' | 'keyword' | 'semantic' = 'hybrid'): Promise<SearchHit[]> {
  q = q.trim().slice(0, 300);
  if (!q) return [];
  const site = await getSiteData(space);
  const scores = new Map<string, number>();
  const chunkById = new Map<string, ChunkRow>();
  const K = 60;

  if (mode !== 'semantic') {
    const terms = tokenize(q).slice(0, 12);
    const boolean = terms.map((t) => `+${t.replace(/[^\p{L}\p{N}]/gu, '')}*`).join(' ');
    let rows: ChunkRow[] = [];
    try {
      rows = await query<ChunkRow>(
        `SELECT id, page_stable_id, heading, anchor, text,
           MATCH(heading, text) AGAINST (? IN NATURAL LANGUAGE MODE) AS nl
         FROM page_chunks WHERE space_id=? AND (MATCH(heading, text) AGAINST (? IN BOOLEAN MODE) OR MATCH(heading, text) AGAINST (? IN NATURAL LANGUAGE MODE))
         ORDER BY nl DESC LIMIT 50`,
        [q, space.id, boolean || q, q],
      );
    } catch {
      rows = [];
    }
    if (!rows.length) {
      // Fallback for very short terms below the full-text minimum token size.
      rows = await query<ChunkRow>(
        `SELECT id, page_stable_id, heading, anchor, text FROM page_chunks WHERE space_id=? AND (text LIKE ? OR heading LIKE ?) LIMIT 50`,
        [space.id, `%${q}%`, `%${q}%`],
      );
    }
    // Title matches get a strong boost.
    const titleHits = site.flat.filter((p) => p.title.toLowerCase().includes(q.toLowerCase()));
    rows.forEach((r, i) => {
      scores.set(r.id, (scores.get(r.id) || 0) + 1 / (K + i));
      chunkById.set(r.id, r);
    });
    if (titleHits.length) {
      const all = await loadVectors(space.id, space.content_version);
      titleHits.forEach((p, i) => {
        const first = all.find((c) => c.page_stable_id === p.stable_id);
        if (first) {
          scores.set(first.id, (scores.get(first.id) || 0) + 1.5 / (K + i));
          chunkById.set(first.id, first);
        }
      });
    }
  }

  if (mode !== 'keyword') {
    const all = await loadVectors(space.id, space.content_version);
    if (all.length) {
      const model = embedModelName();
      let qv: number[];
      const usable = all.filter((c) => c.embed_model === model);
      try {
        qv = model === LOCAL_EMBED_MODEL ? localEmbed(q) : (await embed([q]))[0];
      } catch {
        qv = localEmbed(q);
      }
      const pool = usable.length ? usable : all.filter((c) => c.embed_model === LOCAL_EMBED_MODEL);
      const ranked = pool
        .map((c) => ({ c, s: cosine(qv, c.vec) }))
        .filter((x) => x.s > (model === LOCAL_EMBED_MODEL ? 0.12 : 0.3))
        .sort((a, b) => b.s - a.s)
        .slice(0, 30);
      ranked.forEach(({ c }, i) => {
        scores.set(c.id, (scores.get(c.id) || 0) + 1 / (K + i));
        chunkById.set(c.id, c);
      });
    }
  }

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const [id, score] of [...scores.entries()].sort((a, b) => b[1] - a[1])) {
    const c = chunkById.get(id)!;
    const page = site.byStable.get(c.page_stable_id);
    if (!page || page.hidden) continue;
    const key = `${c.page_stable_id}|${c.anchor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      pageStableId: c.page_stable_id,
      title: page.title,
      path: page.path,
      heading: c.heading,
      anchor: c.anchor,
      snippet: makeSnippet(c.text, q),
      text: c.text,
      score: Math.round(score * 10000) / 10000,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
