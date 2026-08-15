#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
構建寧波話羅馬字文獻查詢網站（純靜態，供 GitHub Pages 部署）。

輸入：
  倉庫根目錄的 字.tsv / 詞.tsv（查詢索引）
  各書目文件夾下的 *-ruby.md（原文 + ruby 注音，上下文與閱讀頁的來源）

產出（web/ 目錄）：
  data/books.json        書目與章節索引
  data/syllables.json    字音（來自 字.tsv）
  data/words.json        詞彙（來自 詞.tsv）
  data/word-books.json   詞 → 所在章節 索引（上下文頁按需抓取）
  src/{book}/{stem}.md   ruby 原文（上下文頁由 JS 抓取解析）
  read/{book}/{stem}.html 閱讀頁（每行帶行號錨點 L{行號}）
  read/{book}/index.html  書目章節索引頁

行號約定：上下文與閱讀頁都以 ruby 原文的原始行號為準，
閱讀頁每個非空段落渲染為 <p id="L{行號}">，點擊上下文可跳轉到對應行。
"""
import csv
import glob
import json
import os
import re
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

# 書目配置：id = 文件夾名；title = 繁體書名（用於在文件夾中挑選繁體 ruby 檔）
BOOKS = [
    {"id": "di-li-shü-kyün-s-1852", "title": "地理書 卷四"},
    {"id": "tsʽông-shü-kyi-1899", "title": "創世記"},
    {"id": "sing-iah-shü-1868", "title": "新約書", "sub": "繁體"},
    {"id": "tsæn-me-s-1860", "title": "讚美詩"},
    {"id": "gyüong-nying-iah-seh-1868", "title": "窮人約瑟"},
    {"id": "sæn-peng-siao-veng-shü-1866", "title": "三本小文書"},
    {"id": "siao-hyin-li-1868", "title": "小顯理等其個底下人蒲齊"},
    {"id": "four-stories-1869", "title": "四則故事"},
    {"id": "cʽih-yiæ-gyih-kyi-1899", "title": "出埃及記"},
]

RUBY_RE = re.compile(r"<rb>(.*?)</rb><rt>(.*?)</rt>", re.S)
SUP_RE = re.compile(r"<sup>.*?</sup> ?", re.S)
U_RE = re.compile(r"</?u>")
STAR_RE = re.compile(r"[*\\]")

# 使用專名號（<u>）標註了人名、地名的書目（見各書 README）
UNDERLINE_BOOKS = {
    "tsʽông-shü-kyi-1899",   # 創世記
    "sing-iah-shü-1868",     # 新約書
    "cʽih-yiæ-gyih-kyi-1899",  # 出埃及記
    "di-li-shü-kyün-s-1852",   # 地理書 卷四
}


def clean_line(text, underline):
    """渲染前的行清理：還原轉義（\\. \\[ \\]）、*斜體* 轉 <em>、去掉專名標記（非標註書目）。"""
    if not underline:
        text = U_RE.sub("", text)
    text = text.replace("\\[", "[").replace("\\]", "]").replace("\\.", ".").replace("\\*", "*")
    text = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", text)
    return text


def chapter_sort_key(path):
    """按章節序號排序（如 1_馬太傳福音書-ruby.md），無序號的排在後面。"""
    m = re.match(r"^(\d+)_", os.path.basename(path))
    if m:
        return (0, int(m.group(1)), os.path.basename(path))
    return (1, 0, os.path.basename(path))


def detect_wip(book):
    """檢查書名對應的非 ruby Markdown 檔是否含「！WIP」未轉寫完標記。"""
    folder = os.path.join(ROOT, book["id"])
    for path in glob.glob(os.path.join(folder, "*.md")):
        if path.endswith(("-ruby.md", "-ori.md")):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                if "！WIP" in f.read():
                    return True
        except OSError:
            continue
    return False


def find_ruby_files(book):
    folder = os.path.join(ROOT, book["id"])
    if book.get("sub"):
        pattern = os.path.join(folder, book["sub"], "*-ruby.md")
    else:
        pattern = os.path.join(folder, "*-ruby.md")
    files = sorted(glob.glob(pattern), key=chapter_sort_key)
    # 非多章節書：優先選與繁體書名完全一致的檔（排除簡體版本）
    # 檔名中的「-」對應書名中的空格，故先做替換
    if not book.get("sub"):
        exact = os.path.join(folder, book["title"].replace(" ", "-") + "-ruby.md")
        if os.path.isfile(exact):
            files = [exact]
    return files


def chapter_title(path):
    name = os.path.splitext(os.path.basename(path))[0]
    name = re.sub(r"-ruby$", "", name)
    return re.sub(r"^\d+_", "", name)


def read_lines(path):
    with open(path, encoding="utf-8") as f:
        return f.read().split("\n")


def parse_words(line):
    """解析一行的 ruby 詞：返回 [(漢字, 羅馬字), ...]。"""
    line = SUP_RE.sub(" ", line)
    out = []
    for m in RUBY_RE.finditer(line):
        h = STAR_RE.sub("", U_RE.sub("", m.group(1))).strip()
        r = STAR_RE.sub("", U_RE.sub("", m.group(2))).strip()
        if h:
            out.append((h, r))
    return out


def load_tsv(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for row in csv.reader(f, delimiter="\t"):
            if not row or not row[0]:
                continue
            row[0] = row[0].lstrip("\ufeff")
            if row[0] == "羅馬字":
                continue
            freq = int(row[2]) if len(row) > 2 and row[2].isdigit() else 0
            rows.append([row[0], row[1], freq])
    return rows


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def heading_text(content):
    """提取標題的純漢字文本（去掉 ruby 注音），用於目錄側欄。"""
    rbs = re.findall(r"<rb>(.*?)</rb>", content)
    if rbs:
        text = "".join(U_RE.sub("", rb) for rb in rbs)
    else:
        text = re.sub(r"<[^>]+>", "", content)
    return re.sub(r"\s+", " ", text).strip()


PAGE_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{chapter} — {book}</title>
<link rel="stylesheet" href="../../assets/style.css">
</head>
<body data-page="read">
<header class="topbar">
  <a class="brand" href="../../index.html">寧波話羅馬字文獻</a>
  <nav class="booknav">
    <a href="index.html">{bookdisp}</a>
    <span class="crumb">/</span>
    <span>{chapter}</span>
  </nav>
  <div class="topbar-search" id="page-find" role="search">
    <input type="text" id="page-find-input" placeholder="搜本頁內容">
    <button type="button" id="page-find-prev" title="上一個">↑</button>
    <button type="button" id="page-find-next" title="下一個">↓</button>
    <span class="find-count" id="page-find-count"></span>
  </div>
  <button id="toggle-toc" type="button">導航</button>
  <button id="toggle-rt" type="button">隱藏羅馬字</button>
</header>
<main class="read-main">
{content}
</main>
<footer class="site-footer">
  <a href="../../search.html">查詢</a> · <a href="../../index.html">首頁</a>
  {prevnext}
</footer>
<aside class="toc" id="toc">
{toc}
</aside>
<div class="toc-overlay" id="toc-overlay"></div>
<script src="../../assets/app.js"></script>
</body>
</html>
"""


def gen_read_page(book, chapter, path, chapters):
    lines = read_lines(path)
    underline = book["id"] in UNDERLINE_BOOKS
    wip = book.get("wip", False)
    wip_tag = '<span class="wip-tag">（尚未轉寫完）</span>' if wip else ""
    book_disp = book["title"] + wip_tag

    # 預掃描：按文檔順序收集注釋行的行號與序號，與正文中的空上標一一配對
    fn_lines = []
    for lineno, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if stripped.startswith("<sup>") and stripped.endswith("</sup>"):
            m = re.search(r"\\\[(\d+)(?:, *\d+)*\\\]", stripped)
            fn_lines.append((lineno, int(m.group(1)) if m else None))
    sup_state = {"k": 0}

    def repl_footnote_ref(m):
        k = sup_state["k"]
        sup_state["k"] += 1
        if k < len(fn_lines):
            fn_lineno, num = fn_lines[k]
            if num:
                return f'<a class="fn-ref" href="#L{fn_lineno}">[{num}]</a>'
        return ""

    parts = []
    toc_items = []
    title_h1_done = False
    for lineno, raw in enumerate(lines, 1):
        text = raw.rstrip("\n")
        if not text.strip():
            continue
        if text.lstrip().startswith("#"):
            level = min(len(text) - len(text.lstrip("#")), 6)
            content = clean_line(text.lstrip("#").strip(), underline)
            if wip and level == 1 and not title_h1_done:
                content += wip_tag
                title_h1_done = True
            toc_items.append((level, lineno, heading_text(content)))
            parts.append(f'<h{level} id="L{lineno}">{content}</h{level}>')
            continue
        if text.strip() == "---":
            parts.append("<hr>")
            continue
        if text.strip().startswith("<sup>") and text.strip().endswith("</sup>"):
            # 注釋行：整行上標是作者用來模擬小字號的注釋，保留在原位，渲染為文內小字號段落
            content = clean_line(text.strip()[5:-6], underline)
            parts.append(f'<p class="fn" id="L{lineno}">{content}</p>')
            continue
        content = clean_line(text, underline)
        # 正文中的空上標是注釋引用位，配上對應的注釋序號
        content = re.sub(r"<sup>\s*</sup>", repl_footnote_ref, content)
        parts.append(f'<p class="para" id="L{lineno}">{content}</p>')

    toc = ['<h3>導航</h3>', f'<nav class="toc-book"><a href="index.html">《{book_disp}》</a></nav>']
    if len(chapters) > 1:
        toc.append('<nav class="toc-chapters"><h4>章節</h4>')
        toc.extend(f'<a href="{c["file"]}.html" class="lv2">{c["title"]}</a>' for c in chapters)
        toc.append("</nav>")
    if toc_items:
        toc.append('<nav class="toc-sections"><h4>本章</h4>')
        toc.extend(f'<a href="#L{ln}" class="lv{min(lv, 3)}">{title}</a>' for lv, ln, title in toc_items)
        toc.append("</nav>")

    idx = chapters.index(chapter)
    prev = chapters[idx - 1] if idx > 0 else None
    nxt = chapters[idx + 1] if idx < len(chapters) - 1 else None
    nav = ""
    if prev:
        nav += f'<a href="{prev["file"]}.html">← {prev["title"]}</a> · '
    if nxt:
        nav += f'<a href="{nxt["file"]}.html">{nxt["title"]} →</a>'

    content = "\n".join(parts)
    html_text = PAGE_TEMPLATE.format(
        chapter=chapter["title"], book=book["title"], bookdisp=book_disp,
        content=content, prevnext=nav, toc="\n".join(toc),
    )
    out_dir = os.path.join(WEB, "read", book["id"])
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, chapter["file"] + ".html"), "w", encoding="utf-8") as f:
        f.write(html_text)


BOOK_INDEX_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{book}</title>
<link rel="stylesheet" href="../../assets/style.css">
</head>
<body>
<header class="topbar">
  <a class="brand" href="../../index.html">寧波話羅馬字文獻</a>
  <form class="topbar-search" action="../../search.html" role="search">
    <input type="text" name="q" placeholder="查漢字/羅馬字">
    <button type="submit">搜</button>
  </form>
</header>
<main class="chapter-main">
<h1>{bookdisp}</h1>
<ul class="chapter-list">
{items}
</ul>
</main>
<footer class="site-footer"><a href="../../index.html">首頁</a></footer>
</body>
</html>
"""


def gen_book_index(book, chapters):
    items = "\n".join(
        f'<li><a href="{c["file"]}.html">{c["title"]}</a></li>' for c in chapters
    )
    wip_tag = '<span class="wip-tag">（尚未轉寫完）</span>' if book.get("wip", False) else ""
    html_text = BOOK_INDEX_TEMPLATE.format(
        book=book["title"], bookdisp=book["title"] + wip_tag, items=items,
    )
    out_dir = os.path.join(WEB, "read", book["id"])
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8") as f:
        f.write(html_text)


def main():
    for sub in ("read", "src", "data"):
        shutil.rmtree(os.path.join(WEB, sub), ignore_errors=True)
        os.makedirs(os.path.join(WEB, sub), exist_ok=True)

    write_json(os.path.join(WEB, "data", "syllables.json"), load_tsv(os.path.join(ROOT, "字.tsv")))
    write_json(os.path.join(WEB, "data", "words.json"), load_tsv(os.path.join(ROOT, "詞.tsv")))

    word_books = {}
    books_out = []
    for book in BOOKS:
        book["wip"] = detect_wip(book)
        files = find_ruby_files(book)
        chapters = []
        for path in files:
            stem = os.path.splitext(os.path.basename(path))[0]
            chapter = {
                "title": chapter_title(path),
                "file": stem,
                "read": f"read/{book['id']}/{stem}.html",
                "md": f"src/{book['id']}/{stem}.md",
            }
            chapters.append(chapter)
            src_dir = os.path.join(WEB, "src", book["id"])
            os.makedirs(src_dir, exist_ok=True)
            if book["id"] in UNDERLINE_BOOKS:
                shutil.copyfile(path, os.path.join(src_dir, stem + ".md"))
            else:
                with open(path, encoding="utf-8") as f, \
                        open(os.path.join(src_dir, stem + ".md"), "w", encoding="utf-8") as g:
                    g.write(U_RE.sub("", f.read()))
            for lineno, raw in enumerate(read_lines(path), 1):
                for h, r in parse_words(raw):
                    word_books.setdefault(f"{h}\t{r.lower()}", set()).add(f"{book['id']}/{stem}")
        if not chapters:
            print(f"跳过：{book['id']} 無 ruby 檔")
            continue
        for chapter in chapters:
            gen_read_page(book, chapter, os.path.join(ROOT, book["id"], book.get("sub", ""), chapter["file"] + ".md"), chapters)
        gen_book_index(book, chapters)
        books_out.append({"id": book["id"], "title": book["title"], "wip": book["wip"], "chapters": chapters})

    write_json(os.path.join(WEB, "data", "books.json"), books_out)
    write_json(os.path.join(WEB, "data", "word-books.json"), {k: sorted(v) for k, v in word_books.items()})

    n_chapters = sum(len(b["chapters"]) for b in books_out)
    print(f"完成：{len(books_out)} 本書、{n_chapters} 個章節，"
          f"字音 {len(load_tsv(os.path.join(ROOT, '字.tsv')))} 條、詞彙 {len(load_tsv(os.path.join(ROOT, '詞.tsv')))} 條，"
          f"{len(word_books)} 個詞有上下文索引")


if __name__ == "__main__":
    main()
