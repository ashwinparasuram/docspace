import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertCircle, Bot, Eye, MessageCircleQuestion, Search, PenLine, ThumbsDown, ThumbsUp, Users } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useMeta } from '../../lib/auth';
import { cn, timeAgo } from '../../lib/utils';
import { Badge, EmptyState, PageLoader, Spinner, Tabs, useToast } from '../../components/ui';

// Validated categorical palette (light/dark steps of the same hues) — see dataviz validator.
const SERIES = [
  { key: 'pageviews', label: 'Page views', light: '#2557d6', dark: '#3b6ef5' },
  { key: 'aiAgents', label: 'AI agent requests', light: '#0d9488', dark: '#0d9488' },
  { key: 'searches', label: 'Searches', light: '#d97706', dark: '#d97706' },
];

function useDark() {
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

function Stat({ icon: Icon, label, value, hint }: { icon: any; label: string; value: number | string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="muted flex items-center gap-1.5 text-xs font-medium">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      {hint && <div className="muted text-xs">{hint}</div>}
    </div>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="muted border-b border-slate-200 text-left text-xs dark:border-slate-800">
            {head.map((h, i) => (
              <th key={h} className={cn('py-2 pr-3 font-medium', i > 0 && 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!rows.length && (
            <tr>
              <td colSpan={head.length} className="muted py-6 text-center text-sm">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
              {r.map((c, j) => (
                <td key={j} className={cn('py-2 pr-3', j > 0 && 'text-right tabular-nums')}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Panel({ title, children, className }: { title: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('card p-5', className)}>
      <h3 className="mb-3 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export default function Insights({ space }: { space: any }) {
  const [tab, setTab] = useState<'analytics' | 'gaps' | 'quality'>('analytics');
  const [days, setDays] = useState(30);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Insights</h1>
            <p className="muted text-sm">How readers and AI agents use your published documentation.</p>
          </div>
          {tab !== 'quality' && (
            <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Date range">
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last year</option>
            </select>
          )}
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'analytics', label: 'Analytics' },
            { id: 'gaps', label: 'Content gaps' },
            { id: 'quality', label: 'Quality checks' },
          ]}
        />
        <div className="mt-6">
          {tab === 'analytics' && <Analytics space={space} days={days} />}
          {tab === 'gaps' && <Gaps space={space} days={days} />}
          {tab === 'quality' && <Quality space={space} />}
        </div>
      </div>
    </div>
  );
}

function Analytics({ space, days }: { space: any; days: number }) {
  const dark = useDark();
  const [showTable, setShowTable] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ['analytics', space.id, days], queryFn: () => api.get(`/spaces/${space.id}/analytics?days=${days}`) });
  if (isLoading) return <PageLoader />;
  if (error) return <EmptyState title="Could not load analytics" description={(error as ApiError).message} />;
  const t = data.totals;
  const helpful = t.positive + t.negative ? Math.round((t.positive / (t.positive + t.negative)) * 100) : null;

  // Fill missing days so the time axis is continuous.
  const byDay = new Map(data.series.map((s: any) => [s.day, s]));
  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86400_000).toISOString().slice(0, 10);
    return { day: d, pageviews: 0, visitors: 0, aiAgents: 0, searches: 0, aiQuestions: 0, ...(byDay.get(d) as object) };
  });
  const axis = dark ? '#64748b' : '#94a3b8';
  const grid = dark ? '#1e293b' : '#f1f5f9';

  return (
    <div className="space-y-6">
      {!space.published && <div className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">This space is not published yet — analytics appear once readers visit the site.</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat icon={Eye} label="Page views" value={t.pageviews} />
        <Stat icon={Users} label="Visitors" value={t.visitors} hint="anonymous, daily" />
        <Stat icon={Search} label="Searches" value={t.searches} />
        <Stat icon={MessageCircleQuestion} label="Assistant questions" value={t.ai_questions} />
        <Stat icon={Bot} label="AI agent requests" value={t.ai_agent_requests} hint={`${t.markdown_requests} Markdown fetches`} />
        <Stat icon={ThumbsUp} label="Helpful" value={helpful === null ? '—' : `${helpful}%`} hint={`${t.positive + t.negative} ratings`} />
      </div>

      <Panel
        title={
          <span className="flex items-center justify-between">
            Traffic
            <button className="text-xs font-normal text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500 dark:text-slate-100 dark:decoration-slate-600" onClick={() => setShowTable(!showTable)}>
              {showTable ? 'Show chart' : 'Show table'}
            </button>
          </span>
        }
      >
        {showTable ? (
          <div className="max-h-80 overflow-y-auto">
            <Table head={['Day', ...SERIES.map((s) => s.label)]} rows={[...series].reverse().map((s: any) => [s.day, ...SERIES.map((x) => s[x.key])])} empty="No data" />
          </div>
        ) : (
          <div className="h-72">
            <ResponsiveContainer>
              <LineChart data={series} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="day" tick={{ fill: axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: grid }} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} />
                <YAxis allowDecimals={false} tick={{ fill: axis, fontSize: 11 }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{ background: dark ? '#0f172a' : '#fff', border: `1px solid ${dark ? '#1e293b' : '#e2e8f0'}`, borderRadius: 8, fontSize: 12, color: dark ? '#e2e8f0' : '#0f172a' }}
                  cursor={{ stroke: axis, strokeDasharray: '3 3' }}
                />
                <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: axis }} />
                {SERIES.map((s) => (
                  <Line key={s.key} type="linear" dataKey={s.key} name={s.label} stroke={dark ? s.dark : s.light} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: dark ? '#0f172a' : '#fff' }} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Top pages">
          <Table head={['Page', 'Views', 'Visitors']} rows={data.topPages.map((p: any) => [p.title, p.views, p.visitors])} empty="No page views yet" />
        </Panel>
        <Panel title="Top searches">
          <Table
            head={['Query', 'Searches', 'No results']}
            rows={data.searches.map((s: any) => [s.query, s.count, s.noResults ? <Badge tone="amber">{s.noResults}</Badge> : '0'])}
            empty="No searches yet"
          />
        </Panel>
        <Panel
          title={
            <span className="flex items-center gap-2">
              <Bot className="h-4 w-4" /> AI agents
            </span>
          }
        >
          <p className="muted mb-3 text-xs">Requests from AI crawlers and assistants (ChatGPT, Claude, Perplexity…), including Markdown and llms.txt fetches.</p>
          <Table head={['Agent', 'Requests', 'Markdown']} rows={data.agents.map((a: any) => [a.agent, a.requests, a.markdown])} empty="No AI agent traffic yet" />
          {data.agentPages.length > 0 && (
            <>
              <h4 className="muted mb-1 mt-4 text-xs font-semibold uppercase">Most-read by agents</h4>
              <Table head={['Page', 'Requests']} rows={data.agentPages.map((a: any) => [a.title || a.path, a.requests])} empty="" />
            </>
          )}
        </Panel>
        <Panel title="Recent assistant questions">
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {!data.aiQuestions.length && <p className="muted py-6 text-center text-sm">No questions yet</p>}
            {data.aiQuestions.map((q: any, i: number) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                {q.unanswered ? <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none text-amber-500" /> : <MessageCircleQuestion className="mt-0.5 h-3.5 w-3.5 flex-none text-slate-400" />}
                <span className="flex-1">{q.question}</span>
                <span className="muted flex-none text-xs">{timeAgo(q.at)}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Reader feedback">
          <Table
            head={['Page', 'Helpful', 'Not helpful']}
            rows={data.feedback.map((f: any) => [f.title, f.positive, f.negative ? <span className="text-red-600">{f.negative}</span> : 0])}
            empty="No ratings yet"
          />
          {data.feedbackComments.length > 0 && (
            <div className="mt-4 space-y-2">
              {data.feedbackComments.map((c: any, i: number) => (
                <div key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/50">
                  <div className="muted mb-0.5 flex items-center gap-1.5 text-xs">
                    {c.rating > 0 ? <ThumbsUp className="h-3 w-3" /> : <ThumbsDown className="h-3 w-3" />} {c.title} · {timeAgo(c.at)}
                  </div>
                  {c.comment}
                </div>
              ))}
            </div>
          )}
        </Panel>
        <Panel title="Top referrers">
          <Table head={['Referrer', 'Visits']} rows={data.referrers.map((r: any) => [<span className="break-all">{r.referrer}</span>, r.count])} empty="No external referrers yet" />
        </Panel>
      </div>
    </div>
  );
}

function Gaps({ space, days }: { space: any; days: number }) {
  const meta = useMeta();
  const toast = useToast();
  const { orgSlug } = useParams();
  const { data, isLoading } = useQuery({ queryKey: ['gaps', space.id, days], queryFn: () => api.get(`/spaces/${space.id}/gaps?days=${days}`) });
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (isLoading) return <PageLoader />;
  const main = space.branches.find((b: any) => b.is_main);
  const queries = [...data.zeroResultSearches.map((z: any) => z.query), ...data.unansweredQuestions.map((u: any) => u.question)];
  return (
    <div className="space-y-6">
      <div className="card flex flex-wrap items-center gap-4 p-5">
        <div className="flex-1">
          <h3 className="font-semibold">Missing topics</h3>
          <p className="muted text-sm">Readers searched for or asked about these and found nothing useful. Grouped by shared keywords.</p>
        </div>
        <button
          className="btn-primary"
          disabled={!queries.length || !meta.data?.ai.llm || busy}
          title={meta.data?.ai.llm ? '' : 'Requires a configured AI model'}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await api.post(`/spaces/${space.id}/gaps/suggest`, { queries: queries.slice(0, 100) });
              setSuggestion(res.markdown);
            } catch (err) {
              toast((err as ApiError).message, 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner className="text-current" /> : <PenLine className="h-4 w-4" />} Suggest pages
        </button>
      </div>
      {suggestion && <div className="card whitespace-pre-wrap p-5 text-sm leading-6">{suggestion}</div>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Suggested topics">
          {!data.suggestedTopics.length && <p className="muted py-6 text-center text-sm">No gaps detected — readers are finding what they need.</p>}
          <div className="space-y-2">
            {data.suggestedTopics.map((t: any, i: number) => (
              <div key={i} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <span className="font-medium capitalize">{t.topic}</span>
                  <Badge tone="amber">{t.count}×</Badge>
                </div>
                <div className="muted mt-1 text-xs">{t.queries.slice(0, 5).join(' · ')}</div>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Searches with no results">
          <Table head={['Query', 'Count']} rows={data.zeroResultSearches.map((z: any) => [z.query, z.count])} empty="None" />
        </Panel>
        <Panel title="Unanswered AI questions">
          <Table head={['Question', 'Count']} rows={data.unansweredQuestions.map((u: any) => [u.question, u.count])} empty="None" />
        </Panel>
        <Panel title="Pages readers found unhelpful">
          <Table head={['Page', 'Helpful', 'Not helpful']} rows={data.unhelpfulPages.map((p: any) => [p.title, p.positive, p.negative])} empty="None" />
        </Panel>
        <Panel title={`Pages with no views (${data.unvisitedPages.length})`} className="lg:col-span-2">
          <p className="muted mb-2 text-xs">Possibly hard to find, poorly titled, or no longer needed.</p>
          <div className="flex flex-wrap gap-2">
            {data.unvisitedPages.map((p: any) => (
              <Link key={p.stableId} to={`/o/${orgSlug}/s/${space.id}/b/${main.id}`} className="rounded-md bg-slate-100 px-2 py-1 text-xs dark:bg-slate-800">
                {p.title}
              </Link>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Quality({ space }: { space: any }) {
  const { orgSlug } = useParams();
  const main = space.branches.find((b: any) => b.is_main);
  const { data, isLoading } = useQuery({ queryKey: ['space-quality', space.id], queryFn: () => api.get(`/spaces/${space.id}/quality`) });
  if (isLoading) return <PageLoader />;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat icon={PenLine} label="Average quality score" value={`${data.averageScore}/100`} />
        <Stat icon={AlertCircle} label="Pages with errors" value={data.pages.filter((p: any) => p.issues.some((i: any) => i.severity === 'error')).length} />
        <Stat icon={Eye} label="Pages checked" value={data.pages.length} />
      </div>
      <Panel title="Issues by rule">
        <div className="flex flex-wrap gap-2">
          {Object.entries(data.issueCounts).map(([rule, n]) => (
            <Badge key={rule}>
              {rule} · {n as number}
            </Badge>
          ))}
          {!Object.keys(data.issueCounts).length && <p className="muted text-sm">No issues found.</p>}
        </div>
      </Panel>
      <Panel title="Pages (lowest score first)">
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {data.pages.map((p: any) => (
            <details key={p.pageId} className="py-2">
              <summary className="flex cursor-pointer items-center gap-3 text-sm">
                <Badge tone={p.score >= 85 ? 'green' : p.score >= 60 ? 'amber' : 'red'}>{p.score}</Badge>
                <span className="flex-1 font-medium">{p.title}</span>
                <span className="muted text-xs">
                  {p.words} words · {p.issues.length} issue{p.issues.length === 1 ? '' : 's'}
                </span>
                <Link className="text-xs text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-500 dark:text-slate-100 dark:decoration-slate-600" to={`/o/${orgSlug}/s/${space.id}/b/${main.id}/p/${p.pageId}`} onClick={(e) => e.stopPropagation()}>
                  Open
                </Link>
              </summary>
              <ul className="mt-2 space-y-1 pl-12">
                {p.issues.map((i: any, idx: number) => (
                  <li key={idx} className="flex gap-2 text-xs">
                    <AlertCircle className={cn('mt-0.5 h-3.5 w-3.5 flex-none', i.severity === 'error' ? 'text-red-500' : i.severity === 'warning' ? 'text-amber-500' : 'text-slate-400')} />
                    <span>
                      {i.message} {i.excerpt && <span className="muted italic">“{i.excerpt}”</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </Panel>
    </div>
  );
}
