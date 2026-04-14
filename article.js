const config = window.DTD_NEWS_CONFIG ?? {};
const SUPABASE_URL = config.supabaseUrl || "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON_KEY = config.supabaseAnonKey || "YOUR_ANON_KEY";

if (!window.supabase) {
  throw new Error("Supabase JS chưa được tải. Kiểm tra CDN trong article.html.");
}

const sb = isConfigured() ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const slug = new URLSearchParams(window.location.search).get("slug") || location.hash.replace(/^#/, "");

const els = {
  title: document.getElementById("articleTitle"),
  summary: document.getElementById("articleSummary"),
  category: document.getElementById("articleCategory"),
  time: document.getElementById("articleTime"),
  sourceCount: document.getElementById("articleSourceCount"),
  body: document.getElementById("articleBody"),
  sourceList: document.getElementById("sourceList"),
  relatedList: document.getElementById("relatedList"),
  relatedSearch: document.getElementById("relatedSearch"),
  refresh: document.getElementById("refreshBtn"),
};

const state = {
  article: null,
  related: [],
  query: "",
};

els.refresh.addEventListener("click", loadArticle);
els.relatedSearch.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderRelated();
});

if (!slug) {
  renderError("Thiếu slug bài viết.");
} else {
  loadArticle();
}

async function loadArticle() {
  if (!sb) {
    renderError("Cấu hình Supabase trước khi xem bài chi tiết.");
    return;
  }

  const { data, error } = await sb
    .from("aggregated_articles")
    .select("id,slug,title,summary,body,category,source_count,published_at,source_links")
    .eq("slug", slug)
    .single();

  if (error || !data) {
    renderError(error?.message || "Không tìm thấy bài viết.");
    return;
  }

  renderArticle(data);
  state.article = data;
  await loadRelated(data.category, data.id, data);
}

async function loadRelated(category, currentId, article) {
  const { data } = await sb
    .from("aggregated_articles")
    .select("id,slug,title,summary,body,published_at,category,source_count")
    .neq("id", currentId)
    .order("published_at", { ascending: false })
    .limit(36);

  state.related = (data ?? [])
    .map((item) => ({
      ...item,
      score: scoreRelated(item, article),
    }))
    .sort((a, b) => b.score - a.score);

  renderRelated();
}

function renderRelated() {
  const query = state.query.trim().toLowerCase();
  const items = state.related
    .filter((item) => {
      if (!query) return true;
      return `${item.title} ${item.summary} ${item.body} ${item.category}`.toLowerCase().includes(query);
    })
    .slice(0, 8);

  els.relatedList.innerHTML = items
    .map(
      (item) => `
        <a class="related-item" href="article.html?slug=${encodeURIComponent(item.slug)}">
          <span class="tag">${escapeHtml(item.category || "Chung")}</span>
          <strong>${escapeHtml(item.title)}</strong>
          <span class="summary">${escapeHtml(item.summary || "")}</span>
          <span class="summary">Độ liên quan: ${Math.round(item.score * 100)}%</span>
        </a>`,
    )
    .join("") || '<div class="card">Chưa có bài liên quan.</div>';
}

function scoreRelated(item, article) {
  if (!article) return 0;
  const articleTokens = tokenSet(`${article.title} ${article.summary} ${article.body}`);
  const itemTokens = tokenSet(`${item.title} ${item.summary} ${item.body}`);
  const overlap = intersectionSize(articleTokens, itemTokens);
  const topicScore = jaccard(articleTokens, itemTokens);
  const sameCategory = article.category === item.category ? 0.18 : 0;
  const sourceBoost = Math.min((item.source_count || 0) / 10, 0.08);
  return Math.min(1, topicScore * 0.7 + (overlap / Math.max(articleTokens.size, 1)) * 0.35 + sameCategory + sourceBoost);
}

function renderArticle(article) {
  els.title.textContent = article.title;
  els.summary.textContent = article.summary;
  els.category.textContent = article.category || "Chung";
  els.time.textContent = new Date(article.published_at).toLocaleString("vi-VN");
  els.sourceCount.textContent = `${article.source_count || 0} nguồn`;
  els.body.innerHTML = `<pre>${escapeHtml(article.body || "")}</pre>`;
  const sources = Array.isArray(article.source_links) ? article.source_links : [];
  els.sourceList.innerHTML = sources
    .map(
      (source) => `
        <a class="source-card" href="${escapeHtml(source.url || "#")}" target="_blank" rel="noreferrer">
          <strong>${escapeHtml(source.name || "Nguồn")}</strong>
          <span>${escapeHtml(source.title || "")}</span>
        </a>`,
    )
    .join("") || '<div class="card">Không có nguồn.</div>';
}

function renderError(message) {
  els.title.textContent = "Không thể tải bài";
  els.summary.textContent = message;
  els.body.innerHTML = `<div class="card">${escapeHtml(message)}</div>`;
  els.sourceList.innerHTML = "";
  els.relatedList.innerHTML = "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isConfigured() {
  return !SUPABASE_URL.includes("YOUR_PROJECT") && SUPABASE_ANON_KEY !== "YOUR_ANON_KEY";
}

function tokenSet(value) {
  const stopwords = new Set(["va", "la", "cho", "voi", "mot", "nhung", "cac", "nay", "the", "o", "tai", "tu", "duoc", "se", "dang", "sau", "trong", "khi", "ve", "lan", "con", "de", "tiep", "theo"]);
  return new Set(
    normalize(value)
      .split(" ")
      .filter((token) => token.length > 2 && !stopwords.has(token)),
  );
}

function jaccard(a, b) {
  return intersectionSize(a, b) / Math.max(unionSize(a, b), 1);
}

function intersectionSize(a, b) {
  let count = 0;
  for (const value of a) if (b.has(value)) count++;
  return count;
}

function unionSize(a, b) {
  return new Set([...a, ...b]).size;
}

function normalize(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
