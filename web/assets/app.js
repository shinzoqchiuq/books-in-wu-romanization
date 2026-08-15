/* 寧波話羅馬字文獻查詢網站 - 前端邏輯 */
"use strict";

/* ---------- 通用工具 ---------- */
const RUBY_RE = /<rb>(.*?)<\/rb><rt>(.*?)<\/rt>/gs;
const SUP_RE = /<sup>.*?<\/sup> ?/gs;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// 含擴展區（B 區起 U+20000 等）的漢字都算漢字；u 標誌讓 \u{20000} 按碼點解析
const CJK_RE = new RegExp("[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{2EBEF}\u{30000}-\u{3134F}]", "u");
function hasCJK(s) {
  return CJK_RE.test(s);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeRuby(h, r) {
  const rt = esc(r).replace(/\*([^*]+)\*/g, "<em>$1</em>"); // 兩個星號之間為斜體
  return `<ruby><rb>${esc(h)}</rb><rt>${rt}</rt></ruby>`;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

/* 緩存抓過的原文，同一會話內重複查詢不重複下載 */
function cachedText(url) {
  const key = "md:" + url;
  const hit = sessionStorage.getItem(key);
  if (hit) return Promise.resolve(hit);
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return res.text();
  }).then((t) => { sessionStorage.setItem(key, t); return t; });
}

/* ---------- 解析 ruby 原文 ---------- */
/* 返回 [{line, tokens:[{t:"w",h,r}|{t:"p",s}, ...]}]，line 為原始行號（1 起）。
   標點符號以 {t:"p"} 形式保留，供上下文展示。 */
function parseChapter(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // 去掉行內 <sup>（腳註標記、章節號）與行首 markdown 標題符，還原 \. \[ \] 轉義
    let line = lines[i].replace(SUP_RE, " ").replace(/^#+\s*/, "").replace(/\\[.\[\]\\]/g, (m) => m[1]);
    const tokens = [];
    let pos = 0;
    RUBY_RE.lastIndex = 0;
    let m;
    while ((m = RUBY_RE.exec(line))) {
      const gap = line.slice(pos, m.index).replace(/<\/?(?:u|ruby)>/g, "").trim();
      if (gap) tokens.push({ t: "p", s: gap });
      const h = m[1].replace(/<\/?(?:u|ruby)>/g, "").replace(/[*\\]/g, "").trim();
      const r = m[2].replace(/<\/?(?:u|ruby)>/g, "").trim(); // 保留 *...* 斜體標記，展示時轉 <em>
      if (h) tokens.push({ t: "w", h, r });
      pos = RUBY_RE.lastIndex;
    }
    const tail = line.slice(pos).replace(/<\/?(?:u|ruby)>/g, "").trim();
    if (tail) tokens.push({ t: "p", s: tail });
    if (tokens.some((x) => x.t === "w")) out.push({ line: i + 1, tokens });
  }
  return out;
}

/* 上下文：前後各 N 個漢字（不計標點），以詞為單位取整（不切詞），段首段尾自然截斷 */
function contextRange(tokens, i, N) {
  const before = [];
  let n = 0;
  for (let k = i - 1; k >= 0 && n < N; k--) {
    before.unshift(tokens[k]);
    if (tokens[k].t === "w") n += tokens[k].h.length;
  }
  const after = [];
  let m = 0;
  for (let k = i + 1; k < tokens.length && m < N; k++) {
    after.push(tokens[k]);
    if (tokens[k].t === "w") m += tokens[k].h.length;
  }
  return { before, after };
}

function renderTokens(tokens) {
  return tokens.map((x) => (x.t === "w" ? makeRuby(x.h, x.r) : esc(x.s))).join("");
}

/* ---------- 首頁：書目列表 ---------- */
async function initIndex() {
  const box = document.getElementById("books");
  if (!box) return;
  let books;
  try {
    books = await fetchJSON("data/books.json");
  } catch (e) {
    box.innerHTML = `<p class="empty-note">書目資料載入失敗。</p>`;
    return;
  }
  box.innerHTML = books.map((b) => `
    <div class="book-item">
      <h3><a href="read/${b.id}/index.html">${esc(b.title)}</a>${b.wip ? `<span class="wip-tag">（尚未轉寫完）</span>` : ""}</h3>
      <div class="chips">
        ${b.chapters.map((c) =>
          `<a class="chip" href="${esc(c.read)}">${esc(c.title)}</a>`).join("")}
      </div>
    </div>`).join("");
}

/* ---------- 查詢頁 ---------- */
async function initSearch() {
  if (!document.getElementById("q")) return;
  const tabBtns = document.querySelectorAll(".tabs button");
  let tab = "syll";
  const state = { syllables: null, words: null };

  tabBtns.forEach((btn) => btn.addEventListener("click", () => {
    tab = btn.dataset.tab;
    tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
    run();
  }));

  const q = document.getElementById("q");
  const regexBox = document.getElementById("regex");
  const exactBox = document.getElementById("exact");
  q.addEventListener("input", run);
  regexBox.addEventListener("change", run);
  exactBox.addEventListener("change", run);

  // 排序狀態：col 0=羅馬字 1=漢字 2=出現次數；預設按出現次數降序
  const sortState = { col: 2, dir: "desc" };

  // 羅馬字特殊字符：點擊插入到光標處
  const romChars = document.getElementById("rom-chars");
  if (romChars) {
    romChars.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-char]");
      if (!btn) return;
      q.focus();
      q.setRangeText(btn.dataset.char, q.selectionStart, q.selectionEnd, "end");
      run();
    });
  }

  function matcher(pattern, text, isRegex, exact) {
    if (exact) return text.toLowerCase() === pattern.toLowerCase();
    if (isRegex) {
      try { return new RegExp(pattern, "iu").test(text); } catch { return false; }
    }
    return text.toLowerCase().includes(pattern.toLowerCase());
  }

  function compareRows(a, b) {
    const { col, dir } = sortState;
    const v = col === 2 ? a[2] - b[2] : a[col].localeCompare(b[col], "zh-Hant");
    return dir === "asc" ? v : -v;
  }

  async function run() {
    const pattern = q.value.trim();
    const isRegex = regexBox.checked;
    const exact = exactBox.checked;
    const out = document.getElementById("results");
    if (!pattern) { out.innerHTML = ""; return; }

    let rows;
    try {
      if (tab === "syll") {
        state.syllables = state.syllables || (await fetchJSON("data/syllables.json"));
        rows = state.syllables;
      } else {
        state.words = state.words || (await fetchJSON("data/words.json"));
        rows = state.words;
      }
    } catch (e) {
      out.innerHTML = `<p class="empty-note">資料載入失敗。</p>`;
      return;
    }

    // 檢測查詢對象：含漢字 → 查漢字欄；否則 → 查羅馬字欄
    const field = hasCJK(pattern) ? 1 : 0;
    const matched = rows.filter((r) => matcher(pattern, r[field], isRegex, exact));
    matched.sort(compareRows);

    const total = matched.length;
    const shown = matched.slice(0, 300);
    const head = `<p class="meta">共 ${total} 條${total > shown.length ? `，僅顯示前 ${shown.length} 條` : ""}</p>`;
    if (!total) {
      const hint = (tab === "syll" && !hasCJK(pattern) && /[- ]/.test(pattern))
        ? `<p class="empty-note">字音表只收錄單音節；多音節詞彙（如含「-」的羅馬字）請切到「詞彙」tab 查詢。</p>`
        : `<p class="empty-note">沒有匹配結果。</p>`;
      out.innerHTML = `<p class="meta">共 0 條</p>${hint}`;
      return;
    }

    const rowsHtml = shown.map((r) => {
      const hanzi = r[1], roman = r[0], freq = r[2];
      const cells = `<td>${esc(hanzi)}</td><td>${esc(roman)}</td><td class="num">${freq}</td>`;
      if (tab === "word") {
        const url = `word.html?h=${encodeURIComponent(hanzi)}&r=${encodeURIComponent(roman)}`;
        return `<tr class="rowlink" data-href="${url}">${cells}</tr>`;
      }
      return `<tr>${cells}</tr>`;
    }).join("");

    const cols = [[1, "漢字"], [0, "羅馬字"], [2, "出現次數"]];
    const thead = `<thead><tr>${cols.map(([col, label]) => {
      const active = sortState.col === col;
      const arrow = active ? (sortState.dir === "asc" ? " ▲" : " ▼") : "";
      return `<th class="sortable${active ? " active" : ""}" data-col="${col}">${label}<span class="arrow">${arrow}</span></th>`;
    }).join("")}</tr></thead>`;

    out.innerHTML = head + `<table class="results">${thead}<tbody>${rowsHtml}</tbody></table>`;

    document.querySelectorAll("#results th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const col = +th.dataset.col;
        if (sortState.col === col) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
        else { sortState.col = col; sortState.dir = "asc"; }
        run();
      });
    });
    document.querySelectorAll("tr.rowlink").forEach((tr) => {
      tr.addEventListener("click", () => { location.href = tr.dataset.href; });
    });
  }

  // 從頂欄搜索跳轉過來：帶上 ?q= 參數，自動填入並查詢
  const qp = new URLSearchParams(location.search).get("q");
  if (qp) {
    q.value = qp;
    run();
  }
}

/* ---------- 詞條詳情頁 ---------- */
const CTX_N = 10; // 前後各 10 個漢字

async function initWord() {
  const headBox = document.getElementById("word-head");
  const ctxBox = document.getElementById("contexts");
  if (!headBox) return;
  const q = new URLSearchParams(location.search);
  const h = q.get("h") || "";
  const r = (q.get("r") || "").toLowerCase();
  if (!h || !r) {
    headBox.innerHTML = `<p class="empty-note">缺少詞條參數。</p>`;
    return;
  }
  const key = `${h}\t${r}`;

  let words, books, wordBooks;
  try {
    [words, books, wordBooks] = await Promise.all([
      fetchJSON("data/words.json"),
      fetchJSON("data/books.json"),
      fetchJSON("data/word-books.json"),
    ]);
  } catch (e) {
    headBox.innerHTML = `<p class="empty-note">資料載入失敗。</p>`;
    return;
  }

  const row = words.find((w) => w[0].toLowerCase() === r && w[1] === h);
  headBox.innerHTML = `
    <div class="word-head">
      <span class="big-word">${makeRuby(h, r)}</span>
      <span class="freq">出現次數：${row ? row[2] : "—"}</span>
    </div>`;

  const refs = wordBooks[key] || [];
  const bookMap = new Map(books.map((b) => [b.id, b]));
  if (!refs.length) {
    ctxBox.innerHTML = `<p class="empty-note">此詞在已收錄的 ruby 原文中未找到上下文。</p>`;
    return;
  }

  const blocks = new Map(); // bookId -> {book, chapters: Map<file, [{line,before,after,target}]>}
  for (const ref of refs) {
    const [bid, file] = ref.split("/");
    const book = bookMap.get(bid);
    if (!book) continue;
    const chapter = book.chapters.find((c) => c.file === file);
    if (!chapter) continue;
    let mdUrl;
    try {
      mdUrl = chapter.md;
      const text = await cachedText(mdUrl);
      const parsed = parseChapter(text);
      for (const { line, tokens } of parsed) {
        for (let i = 0; i < tokens.length; i++) {
          const x = tokens[i];
          if (x.t === "w" && x.r.replace(/[*\\]/g, "").toLowerCase() === r && x.h === h) {
            const { before, after } = contextRange(tokens, i, CTX_N);
            if (!blocks.has(bid)) blocks.set(bid, { book, rows: [] });
            blocks.get(bid).rows.push({ line, before, after, target: x, read: chapter.read });
          }
        }
      }
    } catch (e) {
      console.warn("載入失敗:", mdUrl, e);
    }
  }

  if (!blocks.size) {
    ctxBox.innerHTML = `<p class="empty-note">此詞在已收錄的 ruby 原文中未找到上下文。</p>`;
    return;
  }

  const controls = document.getElementById("ctx-controls");
  const navBox = document.getElementById("ctx-nav");
  const enabled = new Set(blocks.keys());

  // 文獻導航欄（粘性，點擊跳到對應書目）
  navBox.innerHTML = [...blocks.keys()].map((bid) => {
    const { book, rows } = blocks.get(bid);
    return `<a class="ctx-nav-chip" data-book="${esc(bid)}" href="#book-${esc(bid)}">${esc(book.title)}（${rows.length}）</a>`;
  }).join("");
  // 篩選面板：勾選要顯示的文獻
  const filterHtml = [...blocks.keys()].map((bid) => {
    const { book, rows } = blocks.get(bid);
    return `<label><input type="checkbox" data-book="${esc(bid)}" checked> ${esc(book.title)}（${rows.length}）</label>`;
  }).join("");
  controls.innerHTML = `
    <details class="ctx-filter"><summary>文獻篩選（點擊展開，可只顯示部分文獻）</summary>
      <div class="ctx-filter-list">${filterHtml}</div>
    </details>`;

  ctxBox.innerHTML = [...blocks.keys()].map((bid) => {
    const { book, rows } = blocks.get(bid);
    return `
    <div class="book-block" id="book-${esc(bid)}">
      <h3>${esc(book.title)}（${rows.length} 處）</h3>
      ${rows.map(({ line, before, after, target, read }) => `
        <a class="ctx-row" href="${esc(read)}?h=${encodeURIComponent(target.h)}&r=${encodeURIComponent(target.r.replace(/[*\\]/g, ""))}#L${line}">
          <span class="loc">${esc(book.title)} · L${line}</span>
          ${renderTokens(before)}
          <span class="target">${makeRuby(target.h, target.r)}</span>
          ${renderTokens(after)}
        </a>`).join("")}
    </div>`;
  }).join("");

  // 篩選勾選：顯示/隱藏對應書目的區塊與導航項
  controls.addEventListener("change", (e) => {
    const cb = e.target.closest("input[data-book]");
    if (!cb) return;
    const bid = cb.dataset.book;
    const block = document.getElementById("book-" + bid);
    const chip = navBox.querySelector(`.ctx-nav-chip[data-book="${bid}"]`);
    if (cb.checked) {
      enabled.add(bid);
      if (block) block.style.display = "";
      if (chip) chip.style.display = "";
    } else {
      enabled.delete(bid);
      if (block) block.style.display = "none";
      if (chip) chip.style.display = "none";
    }
  });
}

/* ---------- 閱讀頁：行跳轉高亮 + 隱藏羅馬字 + 導航側欄 + 頁內搜索 ---------- */

/* 頁內搜索：高亮本頁所有匹配，可上一個 / 下一個跳轉 */
function initPageFind(box, root) {
  const input = box.querySelector("#page-find-input");
  const prevBtn = box.querySelector("#page-find-prev");
  const nextBtn = box.querySelector("#page-find-next");
  const count = box.querySelector("#page-find-count");
  let marks = [];
  let current = -1;

  function clear() {
    marks.forEach((m) => {
      const p = m.parentNode;
      p.replaceChild(document.createTextNode(m.textContent), m);
      p.normalize();
    });
    marks = [];
    current = -1;
    count.textContent = "";
  }

  function go(step) {
    if (!marks.length) return;
    current = (current + step + marks.length) % marks.length;
    marks.forEach((m, i) => m.classList.toggle("current", i === current));
    marks[current].scrollIntoView({ block: "center", behavior: "smooth" });
    count.textContent = `${current + 1}/${marks.length}`;
  }

  function run() {
    clear();
    const q = input.value.trim();
    if (!q) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const t = n.textContent;
        return t && t.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    let text = "";
    let n;
    while ((n = walker.nextNode())) { nodes.push(n); text += n.textContent; }
    const ql = q.toLowerCase();
    const low = text.toLowerCase();
    const hits = [];
    let i = 0;
    while ((i = low.indexOf(ql, i)) !== -1) { hits.push(i); i += ql.length; }
    // 匹配位置映射回文本節點；逆序包裹，避免節點分裂影響偏移
    const items = [];
    let pos = 0;
    for (const node of nodes) {
      const len = node.textContent.length;
      for (const hi of hits) {
        if (hi >= pos && hi < pos + len) items.push([node, hi - pos, hi - pos + ql.length]);
      }
      pos += len;
    }
    for (const [node, s, e] of items.reverse()) {
      const range = document.createRange();
      range.setStart(node, s);
      range.setEnd(node, e);
      const mark = document.createElement("mark");
      mark.className = "find-hi";
      try { range.surroundContents(mark); marks.push(mark); } catch (err) { /* 忽略邊界情況 */ }
    }
    marks.reverse();
    if (marks.length) go(1);
    else count.textContent = "0";
  }

  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { input.value = ""; clear(); }
  });
  if (nextBtn) nextBtn.addEventListener("click", () => go(1));
  if (prevBtn) prevBtn.addEventListener("click", () => go(-1));
}

function initRead() {
  // 頁內搜索
  const findBox = document.getElementById("page-find");
  const readMain = document.querySelector(".read-main");
  if (findBox && readMain) initPageFind(findBox, readMain);
  const btn = document.getElementById("toggle-rt");
  if (btn) {
    btn.addEventListener("click", () => {
      const off = document.body.classList.toggle("no-rt");
      btn.textContent = off ? "顯示羅馬字" : "隱藏羅馬字";
    });
  }
  // 目錄側欄開關
  const tocBtn = document.getElementById("toggle-toc");
  const toc = document.getElementById("toc");
  const overlay = document.getElementById("toc-overlay");
  if (tocBtn && toc && overlay) {
    const setToc = (open) => {
      document.body.classList.toggle("toc-open", open);
      toc.classList.toggle("open", open);
      overlay.classList.toggle("open", open);
    };
    tocBtn.addEventListener("click", () => setToc(!toc.classList.contains("open")));
    overlay.addEventListener("click", () => setToc(false));
    toc.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setToc(false)));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") setToc(false); });
  }
  // 錨點跳轉（含目錄點擊）時觸發行閃爍
  window.addEventListener("hashchange", () => {
    const m2 = location.hash.match(/^#L(\d+)$/);
    if (!m2) return;
    const el2 = document.getElementById("L" + m2[1]);
    if (el2) {
      el2.classList.remove("target");
      void el2.offsetWidth;
      el2.classList.add("target");
    }
  });
  const m = location.hash.match(/^#L(\d+)$/);
  if (m) {
    const el = document.getElementById("L" + m[1]);
    if (el) {
      el.scrollIntoView();
      el.classList.add("target");
    }
  }
  const q = new URLSearchParams(location.search);
  const r = (q.get("r") || "").toLowerCase();
  const h = q.get("h") || "";
  if (r) {
    document.querySelectorAll("ruby").forEach((rb) => {
      rb.querySelectorAll("rt").forEach((rt) => {
        const rbEl = rt.previousElementSibling;
        if (rt.textContent.toLowerCase() === r &&
            (!h || (rbEl && rbEl.textContent === h))) {
          if (rbEl && rbEl.tagName === "RB") rbEl.classList.add("hit");
        }
      });
    });
  }
}

/* ---------- 入口 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "index") initIndex();
  else if (page === "search") initSearch();
  else if (page === "word") initWord();
  else if (page === "read") initRead();
});
