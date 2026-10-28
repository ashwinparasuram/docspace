import yaml from 'js-yaml';
import { badRequest } from '../util.js';
import type { PMNode } from './prosemirror.js';
import { markdownToJson } from './prosemirror.js';

export interface OpenApiOperation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: any[];
  requestBody?: any;
  responses: Record<string, any>;
  deprecated?: boolean;
  security?: any[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export function parseSpec(text: string): any {
  let spec: any;
  try {
    spec = text.trim().startsWith('{') ? JSON.parse(text) : yaml.load(text);
  } catch (err) {
    throw badRequest(`Could not parse spec: ${(err as Error).message}`);
  }
  if (!spec || typeof spec !== 'object' || (!spec.openapi && !spec.swagger) || !spec.paths) {
    throw badRequest('Not an OpenAPI/Swagger document (missing "openapi" and "paths")');
  }
  if (spec.swagger) spec = swagger2ToOpenApi3(spec);
  return spec;
}

/** Minimal Swagger 2.0 -> OpenAPI 3 conversion for the parts the renderer uses. */
function swagger2ToOpenApi3(s: any): any {
  const scheme = (s.schemes && s.schemes[0]) || 'https';
  const out: any = {
    openapi: '3.0.0',
    info: s.info || {},
    servers: s.host ? [{ url: `${scheme}://${s.host}${s.basePath || ''}` }] : [],
    tags: s.tags || [],
    paths: {},
    components: { schemas: s.definitions || {}, securitySchemes: s.securityDefinitions || {} },
  };
  const fixRefs = (o: any): any =>
    JSON.parse(JSON.stringify(o ?? null).replace(/#\/definitions\//g, '#/components/schemas/'));
  for (const [p, item] of Object.entries<any>(s.paths)) {
    out.paths[p] = {};
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])];
      const body = params.find((x: any) => x.in === 'body');
      const formData = params.filter((x: any) => x.in === 'formData');
      const responses: any = {};
      for (const [code, r] of Object.entries<any>(op.responses || {})) {
        responses[code] = { description: r.description || '', ...(r.schema ? { content: { 'application/json': { schema: fixRefs(r.schema) } } } : {}) };
      }
      out.paths[p][m] = {
        ...op,
        parameters: params.filter((x: any) => x.in !== 'body' && x.in !== 'formData').map((x: any) => ({ ...x, schema: x.schema || { type: x.type, enum: x.enum, format: x.format } })),
        requestBody: body
          ? { required: body.required, content: { 'application/json': { schema: fixRefs(body.schema) } } }
          : formData.length
            ? { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: Object.fromEntries(formData.map((f: any) => [f.name, { type: f.type, description: f.description }])) } } } }
            : undefined,
        responses,
      };
    }
  }
  return fixRefs(out);
}

/** Resolve local "#/..." references, leaving cyclic ones as {$ref, $circular: true}. */
export function deref(spec: any): any {
  const resolvePointer = (ref: string) => {
    const parts = ref.replace(/^#\//, '').split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur = spec;
    for (const p of parts) cur = cur?.[p];
    return cur;
  };
  const walk = (node: any, stack: string[]): any => {
    if (Array.isArray(node)) return node.map((n) => walk(n, stack));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
      if (stack.includes(node.$ref) || stack.length > 25) return { $ref: node.$ref, $circular: true, title: node.$ref.split('/').pop() };
      const target = resolvePointer(node.$ref);
      const resolved = walk(target, [...stack, node.$ref]);
      return resolved && typeof resolved === 'object' && !Array.isArray(resolved) ? { ...resolved, 'x-ref-name': node.$ref.split('/').pop() } : resolved;
    }
    const out: any = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, stack);
    return out;
  };
  return walk(spec, []);
}

export function listOperations(spec: any): OpenApiOperation[] {
  const ops: OpenApiOperation[] = [];
  for (const [path, item] of Object.entries<any>(spec.paths || {})) {
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op) continue;
      ops.push({
        method: m,
        path,
        operationId: op.operationId,
        summary: op.summary,
        description: op.description,
        tags: op.tags?.length ? op.tags : ['Default'],
        parameters: [...(item.parameters || []), ...(op.parameters || [])],
        requestBody: op.requestBody,
        responses: op.responses || {},
        deprecated: !!op.deprecated,
        security: op.security ?? spec.security,
      });
    }
  }
  return ops;
}

export function findOperation(spec: any, method: string, path: string): OpenApiOperation | null {
  return listOperations(spec).find((o) => o.method === method.toLowerCase() && o.path === path) || null;
}

/** Build the page structure for an imported spec: one page per tag with an operation block per endpoint. */
export function specToPages(specId: string, spec: any): { title: string; description: string; doc: PMNode }[] {
  const ops = listOperations(spec);
  const tagOrder: string[] = (spec.tags || []).map((t: any) => t.name);
  const tagDesc = new Map<string, string>((spec.tags || []).map((t: any) => [t.name, t.description || '']));
  const byTag = new Map<string, OpenApiOperation[]>();
  for (const op of ops) {
    const tag = op.tags[0];
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag)!.push(op);
  }
  const tags = [...byTag.keys()].sort((a, b) => {
    const ia = tagOrder.indexOf(a);
    const ib = tagOrder.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
  });
  return tags.map((tag) => {
    const intro = tagDesc.get(tag);
    const content: PMNode[] = [];
    // The first line becomes the page description (shown as the lead); only longer intros are repeated as body text.
    if (intro && intro.trim().includes('\n')) content.push(...(markdownToJson(intro).content || []));
    for (const op of byTag.get(tag)!) {
      content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: op.summary || `${op.method.toUpperCase()} ${op.path}` }] });
      content.push({ type: 'apiOperation', attrs: { specId, method: op.method, path: op.path } });
    }
    return { title: tag, description: intro?.split('\n')[0]?.slice(0, 200) || `${tag} endpoints`, doc: { type: 'doc', content } };
  });
}

export function overviewDoc(spec: any): PMNode {
  const info = spec.info || {};
  const md = [
    info.description || `Reference documentation for ${info.title || 'the API'}.`,
    spec.servers?.length ? `## Base URLs\n\n${spec.servers.map((s: any) => `- \`${s.url}\`${s.description ? ` — ${s.description}` : ''}`).join('\n')}` : '',
    spec.components?.securitySchemes
      ? `## Authentication\n\n${Object.entries<any>(spec.components.securitySchemes)
          .map(([name, s]) => `- **${name}**: ${s.type}${s.scheme ? ` (${s.scheme})` : ''}${s.in ? ` in ${s.in} \`${s.name}\`` : ''}${s.description ? ` — ${s.description}` : ''}`)
          .join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return markdownToJson(md);
}

/** Example JSON value for a schema (used for request body templates and response samples). */
export function exampleFromSchema(schema: any, depth = 0): any {
  if (!schema || depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.$circular) return {};
  if (schema.enum?.length) return schema.enum[0];
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s: any) => exampleFromSchema(s, depth + 1)));
  if (schema.oneOf || schema.anyOf) return exampleFromSchema((schema.oneOf || schema.anyOf)[0], depth + 1);
  switch (schema.type) {
    case 'object':
    case undefined: {
      if (!schema.properties && schema.type === undefined) return schema.items ? [exampleFromSchema(schema.items, depth + 1)] : null;
      const o: any = {};
      for (const [k, v] of Object.entries<any>(schema.properties || {})) o[k] = exampleFromSchema(v, depth + 1);
      return o;
    }
    case 'array':
      return [exampleFromSchema(schema.items, depth + 1)];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'string':
      if (schema.format === 'date-time') return '2024-01-01T00:00:00Z';
      if (schema.format === 'date') return '2024-01-01';
      if (schema.format === 'email') return 'user@example.com';
      if (schema.format === 'uuid') return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
      return 'string';
    default:
      return null;
  }
}
