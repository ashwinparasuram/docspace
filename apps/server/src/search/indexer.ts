import { exec, json, one, query } from '../db.js';
import { logger } from '../logger.js';
import { type PMNode, extractText, inlineText, slugifyHeading, uniqueId } from '../content/prosemirror.js';
import { embed, embedModelName, localEmbed, LOCAL_EMBED_MODEL } from '../ai/provider.js';
import { debounceByKey, uuid } from '../util.js';

interface Chunk {
  heading: string | null;
  anchor: string | null;
  text: string;
}

/** Split a document into heading-scoped chunks of bounded size for retrieval. */
export function chunkDocument(title: string, doc: PMNode): Chunk[] {
  const chunks: Chunk[] = [];
  const used = new Map<string, number>();
  let current: Chunk = { heading: null, anchor: null, text: '' };
  const flush = () => {
    const text = current.text.trim();
    if (text) {
      // Further split long sections on paragraph boundaries.
      const parts: string[] = [];
      let buf = '';
      for (const para of text.split('\n')) {
        if (buf.length + para.length > 1200 && buf) {
          parts.push(buf);
          buf = '';
        }
        buf += (buf ? '\n' : '') + para;
      }
      if (buf) parts.push(buf);
      for (const p of parts) chunks.push({ heading: current.heading, anchor: current.anchor, text: p });
    }
  };
  for (const block of doc.content || []) {
    if (block.type === 'heading') {
      flush();
      const h = inlineText(block);
      current = { heading: h, anchor: uniqueId(slugifyHeading(h), used), text: '' };
      continue;
    }
    current.text += extractText({ type: 'doc', content: [block] }) + '\n';
  }
  flush();
  if (!chunks.length) chunks.push({ heading: null, anchor: null, text: title });
  return chunks;
}

export async function reindexPage(spaceId: string, stableId: string): Promise<void> {
  const page = await one(
    `SELECT p.* FROM pages p JOIN branches b ON b.id=p.branch_id WHERE b.space_id=? AND b.is_main=1 AND p.stable_id=?`,
    [spaceId, stableId],
  );
  await exec('DELETE FROM page_chunks WHERE space_id=? AND page_stable_id=?', [spaceId, stableId]);
  if (!page || page.deleted || page.kind === 'group' || page.kind === 'link') return;
  const doc = json<PMNode>(page.content, { type: 'doc' });
  const chunks = chunkDocument(page.title, doc);
  const inputs = chunks.map((c) => `${page.title}${c.heading ? ' — ' + c.heading : ''}\n${c.text}`);
  let vectors: number[][];
  let model = embedModelName();
  try {
    vectors = await embed(inputs);
  } catch {
    vectors = inputs.map(localEmbed);
    model = LOCAL_EMBED_MODEL;
  }
  for (let i = 0; i < chunks.length; i++) {
    await exec(
      'INSERT INTO page_chunks (id, space_id, page_stable_id, chunk_index, heading, anchor, text, embedding, embed_model) VALUES (?,?,?,?,?,?,?,?,?)',
      [uuid(), spaceId, stableId, i, chunks[i].heading, chunks[i].anchor, chunks[i].text.slice(0, 60000), JSON.stringify(vectors[i]), model],
    );
  }
}

export async function reindexSpace(spaceId: string): Promise<number> {
  const pages = await query<{ stable_id: string }>(
    `SELECT p.stable_id FROM pages p JOIN branches b ON b.id=p.branch_id WHERE b.space_id=? AND b.is_main=1`,
    [spaceId],
  );
  await exec('DELETE FROM page_chunks WHERE space_id=?', [spaceId]);
  for (const p of pages) await reindexPage(spaceId, p.stable_id);
  return pages.length;
}

const pending = debounceByKey<string>(4000, (key) => {
  const [spaceId, stableId] = key.split('|');
  reindexPage(spaceId, stableId).catch((err) => logger.warn('reindex failed', { error: (err as Error).message }));
});

export function scheduleReindex(spaceId: string, stableId: string) {
  pending(`${spaceId}|${stableId}`);
}

/** On boot, rebuild indexes whose embedding model no longer matches the configured one. */
export async function reconcileIndexes(): Promise<void> {
  const model = embedModelName();
  const stale = await query<{ space_id: string }>(
    `SELECT DISTINCT space_id FROM page_chunks WHERE embed_model <> ? LIMIT 50`,
    [model],
  );
  const unindexed = await query<{ space_id: string }>(
    `SELECT DISTINCT b.space_id FROM pages p JOIN branches b ON b.id=p.branch_id
     WHERE b.is_main=1 AND p.deleted=0 AND NOT EXISTS (SELECT 1 FROM page_chunks c WHERE c.space_id=b.space_id) LIMIT 50`,
  );
  const ids = new Set([...stale, ...unindexed].map((r) => r.space_id));
  for (const id of ids) {
    logger.info('Reindexing space', { spaceId: id, model });
    await reindexSpace(id).catch((err) => logger.warn('reindex failed', { error: (err as Error).message }));
  }
}
