const config = window.DTD_NEWS_CONFIG ?? {};
const SUPABASE_URL = config.supabaseUrl || "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON_KEY = config.supabaseAnonKey || "YOUR_ANON_KEY";
const INGEST_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/ingest-news`;
const INGEST_SECRET = config.ingestSecret || "";
const HAS_CONFIG = !SUPABASE_URL.includes("YOUR_PROJECT") && SUPABASE_ANON_KEY !== "YOUR_ANON_KEY";

if (!window.supabase) {
  throw new Error("Supabase JS chưa được tải. Kiểm tra CDN trong index.html.");
}

const sb = HAS_CONFIG ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const state = {
  articles: [],
  category: "all",
  query: "",
};

const els = {
  grid: document.getElementById("articleGrid"),
  meta: document.getElementById("metaText"),
  search: document.getElementById("searchInput"),
  category: document.getElementById("categorySelect"),
  refresh: document.getElementById("refreshBtn"),
  ingest: document.getElementById("ingestBtn"),
  secret: document.getElementById("secretInput"),
};

if (INGEST_SECRET) {
  els.secret.value = INGEST_SECRET;
}

async function loadArticles() {
  if (!sb) {
    els.meta.textContent = "Cấu hình SUPABASE_URL và SUPABASE_ANON_KEY trong app.js trước khi chạy.";
    return;
  }

  els.meta.textContent = "Đang tải dữ liệu...";
  const { data, error } = await sb
    .from("aggregated_articles")
    .select("id,title,summary,body,category,source_count,published_at,slug,source_links")
    .order("published_at", { ascending: false })
    .limit(48);

  if (error) {
    els.meta.textContent = `Lỗi tải dữ liệu: ${error.message}`;
    return;
  }

  state.articles = data ?? [];
  fillCategories(state.articles);
  render();
}

function fillCategories(items) {
  const categories = [...new Set(items.map((item) => item.category).filter(Boolean))].sort();
  const current = els.category.value || state.category;
  els.category.innerHTML = '<option value="all">Tất cả</option>' + categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  els.category.value = categories.includes(current) ? current : "all";
}

function render() {
  const filtered = state.articles.filter((item) => {
    const categoryMatch = state.category === "all" || item.category === state.category;
    const haystack = `${item.title} ${item.summary} ${item.body} ${item.category}`.toLowerCase();
    const queryMatch = !state.query || haystack.includes(state.query.toLowerCase());
    return categoryMatch && queryMatch;
  });

  els.meta.textContent = `${filtered.length} bài tổng hợp hiển thị`;
  els.grid.innerHTML = filtered.map(renderCard).join("") || '<div class="card">Không có bài phù hợp.</div>';
}

function renderCard(item) {
  const time = new Date(item.published_at).toLocaleString("vi-VN");
  const sources = Array.isArray(item.source_links) ? item.source_links : [];
  const sourcePills = sources.slice(0, 4).map((source) => `<span class="source-pill">${escapeHtml(source.name || source.url || "Nguồn")}</span>`).join("");
  const slug = item.slug || item.id;
  return `
    <article class="card" id="${escapeHtml(slug)}">
      <div class="card-top">
        <span class="tag">${escapeHtml(item.category || "Chung")}</span>
        <span class="time">${time}</span>
      </div>
      <h3 class="title">${escapeHtml(item.title)}</h3>
      <p class="summary">${escapeHtml(item.summary || "")}</p>
      <details class="article-body">
        <summary>Xem nội dung tổng hợp</summary>
        <pre>${escapeHtml(item.body || "")}</pre>
      </details>
      <div class="sources">${sourcePills}</div>
      <div class="card-actions">
        <a class="link" href="article.html?slug=${encodeURIComponent(slug)}" aria-label="Xem bài chi tiết">Xem bài chi tiết</a>
      </div>
    </article>`;
}

async function runIngest() {
  if (!HAS_CONFIG) {
    alert("Cấu hình Supabase trước khi chạy ingest.");
    return;
  }

  const secret = els.secret.value.trim();
  if (!secret) {
    alert("Nhập x-ingest-secret trước khi chạy cào tin.");
    return;
  }

  els.ingest.disabled = true;
  els.ingest.textContent = "Đang cào...";
  try {
    const res = await fetch(INGEST_FUNCTION_URL, {
      method: "POST",
      headers: { "x-ingest-secret": secret },
    });
    if (!res.ok) throw new Error(await res.text());
    await loadArticles();
  } catch (error) {
    alert(`Không cào được tin: ${error.message}`);
  } finally {
    els.ingest.disabled = false;
    els.ingest.textContent = "Chạy cào tin";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

els.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

els.category.addEventListener("change", (event) => {
  state.category = event.target.value;
  render();
});

els.refresh.addEventListener("click", loadArticles);
els.ingest.addEventListener("click", runIngest);

loadArticles();
