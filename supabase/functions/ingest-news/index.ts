import { createClient } from "npm:@supabase/supabase-js@2";

type FeedSource = {
  id: string;
  name: string;
  feed_url: string;
  category: string;
};

type NewsItem = {
  source_id: string;
  title: string;
  url: string;
  summary: string;
  content: string;
  image_url: string;
  published_at: string | null;
  fingerprint: string;
  tokens: string[];
};

type IngestRun = {
  id: string;
  started_at: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const INGEST_SECRET = Deno.env.get("INGEST_SECRET") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-secret",
};

const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const secret = req.headers.get("x-ingest-secret") ?? new URL(req.url).searchParams.get("secret") ?? "";
  if (!INGEST_SECRET || secret !== INGEST_SECRET) {
    return new Response("unauthorized", { status: 401, headers: corsHeaders });
  }

  const run = await createRun();

  try {
    const sources = await loadSources();
    const items = await loadItems(sources);
    const stored = await upsertItems(items);
    const articles = await buildAggregates(items, sources);

    await finishRun(run.id, "success", sources.length, stored, articles.length, `Ingest thành công: ${articles.length} bài tổng hợp.`);

    return Response.json(
      { sources: sources.length, items: stored, articles: articles.length, runId: run.id },
      { headers: corsHeaders },
    );
  } catch (error) {
    await finishRun(run.id, "error", 0, 0, 0, error.message);
    return Response.json({ error: error.message }, { status: 500, headers: corsHeaders });
  }
});

async function createRun(): Promise<IngestRun> {
  const { data, error } = await client
    .from("ingest_runs")
    .insert({ status: "running" })
    .select("id,started_at")
    .single();

  if (error) throw error;
  return data;
}

async function finishRun(id: string, status: string, sourcesCount: number, itemsCount: number, articlesCount: number, message: string) {
  const { error } = await client
    .from("ingest_runs")
    .update({
      status,
      sources_count: sourcesCount,
      items_count: itemsCount,
      articles_count: articlesCount,
      message,
      finished_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) throw error;
}

async function loadSources(): Promise<FeedSource[]> {
  const { data, error } = await client
    .from("news_sources")
    .select("id,name,feed_url,category")
    .eq("is_active", true);

  if (error) throw error;
  return data ?? [];
}

async function loadItems(sources: FeedSource[]): Promise<NewsItem[]> {
  const results: NewsItem[] = [];

  for (const source of sources) {
    const response = await fetch(source.feed_url, {
      headers: { "user-agent": "DTD News Aggregator/1.0" },
    });
    if (!response.ok) continue;

    const xml = await response.text();
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (!doc) continue;

    const nodes = [...doc.querySelectorAll("item")].slice(0, 20);

    for (const node of nodes) {
      const title = tagText(node, "title");
      const url = tagText(node, "link");
      if (!title || !url) continue;

      const description = tagText(node, "description");
      const summary = stripHtml(description);
      const content = stripHtml(tagText(node, "content:encoded"));
      const text = `${title} ${summary} ${content}`;

      results.push({
        source_id: source.id,
        title,
        url,
        summary: summary || title,
        content: content || summary || title,
        image_url: extractImageUrl(description),
        published_at: parseDate(tagText(node, "pubDate")),
        fingerprint: fingerprint(text),
        tokens: tokenSet(text),
      });
    }
  }

  return dedupeItems(results);
}

async function upsertItems(items: NewsItem[]) {
  if (!items.length) return 0;

  const payload = items.map(({ tokens, ...item }) => item);
  const { error } = await client
    .from("raw_news_items")
    .upsert(payload, { onConflict: "url" });

  if (error) throw error;
  return payload.length;
}

async function buildAggregates(items: NewsItem[], sources: FeedSource[]) {
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const clusters = clusterItems(items, sourceMap);

  const { error: clearError } = await client.from("aggregated_articles").delete();
  if (clearError) throw clearError;

  const articles = [];
  for (const cluster of clusters) {
    const sorted = [...cluster].sort((a, b) => dateValue(b.published_at) - dateValue(a.published_at));
    const representative = sorted[0];
    if (!representative) continue;

    const uniqueSources = [...new Set(cluster.map((item) => item.source_id))];
    const sourceLinks = sorted.slice(0, 8).map((item) => ({
      title: item.title,
      url: item.url,
      name: sourceMap.get(item.source_id)?.name ?? "Nguồn",
    }));

    const category = sourceMap.get(representative.source_id)?.category ?? "general";
    const topic = deriveTopic(cluster);
    const title = makeAggregateTitle(representative.title, category, topic);
    const summary = makeSummary(cluster);
    const body = makeBody(cluster, sourceMap, topic);
    const slug = `${category}-${topic.slice(0, 4).join("-") || fingerprint(title).slice(0, 8)}-${fingerprint(title).slice(0, 10)}`;

    const payload = {
      slug,
      title,
      summary,
      body,
      category,
      source_count: uniqueSources.length,
      source_links: sourceLinks,
      published_at: representative.published_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await client.from("aggregated_articles").insert(payload);
    if (error) throw error;
    articles.push(payload);
  }

  return articles;
}

function dedupeItems(items: NewsItem[]) {
  const result: NewsItem[] = [];

  for (const item of items.sort((a, b) => dateValue(b.published_at) - dateValue(a.published_at))) {
    const duplicate = result.some((existing) => {
      if (existing.source_id === item.source_id && fingerprintKey(existing) === fingerprintKey(item)) return true;
      return item.fingerprint === existing.fingerprint || titleSimilarity(item, existing) >= 0.9;
    });

    if (!duplicate) result.push(item);
  }

  return result;
}

function clusterItems(items: NewsItem[], sourceMap: Map<string, FeedSource>) {
  const clusters: NewsItem[][] = [];
  const sorted = [...items].sort((a, b) => dateValue(b.published_at) - dateValue(a.published_at));

  for (const item of sorted) {
    const source = sourceMap.get(item.source_id);
    if (!source) continue;

    let bestCluster: NewsItem[] | null = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const clusterSource = sourceMap.get(cluster[0].source_id);
      if (!clusterSource) continue;
      if (clusterSource.category !== source.category) continue;

      const score = clusterSimilarity(item, cluster);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }

    if (bestCluster && bestScore >= 0.33) {
      bestCluster.push(item);
    } else {
      clusters.push([item]);
    }
  }

  return clusters.filter((cluster) => cluster.length >= 2 || cluster[0]);
}

function clusterSimilarity(item: NewsItem, cluster: NewsItem[]) {
  const itemTokens = new Set(item.tokens);
  const clusterTokens = new Set<string>();
  const anchorTitles = cluster.slice(0, 3).map((member) => member.title);

  for (const member of cluster) {
    for (const token of member.tokens) clusterTokens.add(token);
  }

  const lexical = jaccard(itemTokens, clusterTokens);
  const anchorMatch = Math.max(...anchorTitles.map((title) => titleSimilarity(item, { ...item, title })), 0);
  const freshness = Math.max(
    ...cluster.map((member) => {
      const diffHours = Math.abs(dateValue(item.published_at) - dateValue(member.published_at)) / 36e5;
      return diffHours <= 12 ? 0.18 : diffHours <= 24 ? 0.1 : 0;
    }),
    0,
  );
  const sourceDiversity = Math.min(new Set(cluster.map((member) => member.source_id)).size / 4, 0.15);

  return lexical * 0.6 + anchorMatch * 0.25 + freshness + sourceDiversity;
}

function titleSimilarity(a: NewsItem, b: Pick<NewsItem, "title">) {
  return jaccard(tokenSet(a.title), tokenSet(b.title));
}

function makeAggregateTitle(title: string, category: string, topic: string[]) {
  const clean = title.replace(/^(\[[^\]]+\]\s*)+/, "").trim();
  const base = clean.split(":")[0].trim();
  const topicText = topic.slice(0, 3).join(" ");
  const suffix = topicText || base;

  if (category === "the-gioi") return `Tổng hợp thế giới: ${suffix}`;
  if (category === "kinh-doanh") return `Tổng hợp kinh doanh: ${suffix}`;
  return `Tổng hợp tin nóng: ${suffix}`;
}

function makeSummary(group: NewsItem[]) {
  const lead = group[0]?.summary || group[0]?.title || "Tin nổi bật";
  return `${lead}. Bài tổng hợp này gom từ ${group.length} bản tin liên quan của nhiều nguồn chính thống.`;
}

function makeBody(group: NewsItem[], sourceMap: Map<string, FeedSource>, topic: string[]) {
  const bullets = group
    .slice(0, 8)
    .map((item) => {
      const source = sourceMap.get(item.source_id);
      return `- ${source?.name ?? "Nguồn"}: ${item.title} (${item.url})`;
    })
    .join("\n");

  return [
    `Chủ đề chính: ${topic.slice(0, 4).join(", ") || "tổng hợp tin nóng"}`,
    "",
    "Tóm tắt nhanh:",
    group[0]?.summary || group[0]?.title || "Không có mô tả",
    "",
    "Các nguồn liên quan:",
    bullets,
  ].join("\n");
}

function dedupeTopics(tokens: string[]) {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    if (seen.has(token)) return false;
    seen.add(token);
    return true;
  });
}

function deriveTopic(group: NewsItem[]) {
  const frequency = new Map<string, number>();

  for (const item of group) {
    for (const token of item.tokens) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }

  return dedupeTopics(
    [...frequency.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([token]) => token)
      .filter((token) => token.length > 2)
      .slice(0, 6),
  );
}

function tokenSet(value: string) {
  const stopwords = new Set(["va", "la", "cho", "voi", "mot", "nhung", "cac", "nay", "the", "o", "tai", "tu", "duoc", "se", "dang", "sau", "trong", "khi", "ve", "lan", "con", "de", "tiep", "theo", "bang", "cua", "tren", "duoi", "nay"]);
  return normalize(value)
    .split(" ")
    .filter((token) => token.length > 2 && !stopwords.has(token));
}

function jaccard(a: Set<string> | string[], b: Set<string> | string[]) {
  const setA = Array.isArray(a) ? new Set(a) : a;
  const setB = Array.isArray(b) ? new Set(b) : b;
  return intersectionSize(setA, setB) / Math.max(unionSize(setA, setB), 1);
}

function intersectionSize(a: Set<string>, b: Set<string>) {
  let count = 0;
  for (const value of a) if (b.has(value)) count++;
  return count;
}

function unionSize(a: Set<string>, b: Set<string>) {
  return new Set([...a, ...b]).size;
}

function fingerprintKey(item: NewsItem) {
  return `${item.source_id}:${item.fingerprint}`;
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function extractImageUrl(value: string) {
  const match = value.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1] ?? "";
}

function parseDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fingerprint(value: string) {
  return normalize(value)
    .split("")
    .reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)
    .toString(16)
    .replace("-", "n");
}

function normalize(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dateValue(value: string | null) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
