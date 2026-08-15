#!/usr/bin/env bash
# 把工作區中的 *-ruby.md 同步到 site-src 分支并推送，供 GitHub Actions 構建網站。
# 用法：bash web/build/sync-ruby-src.sh
#
# 原理：-ruby.md 在 master 上被 .gitignore 忽略，不入庫；但網站構建需要它們。
# 本腳本把它們複製到獨立的 site-src 分支（只含 -ruby.md），CI 檢出後構建。
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
WT="$ROOT/.ruby-src-wt"

git worktree remove "$WT" --force 2>/dev/null || true

if git show-ref --verify --quiet refs/heads/site-src; then
  echo "==> 使用已有 site-src 分支"
  git worktree add "$WT" site-src
  find "$WT" -name "*-ruby.md" -delete
else
  echo "==> 首次：創建 site-src orphan 分支（只放 -ruby.md）"
  git worktree add "$WT" --detach
  git -C "$WT" checkout --orphan site-src
  # 清掉工作樹裏 master 的文件（orphan 後全部變為 untracked），只留 .git
  ( cd "$WT" && find . -mindepth 1 ! -name .git -delete )
fi

# 把主樹的 *-ruby.md 複製到工作樹
find "$ROOT" \( -path "$ROOT/.git" -o -path "$WT" \) -prune -o -name "*-ruby.md" -print0 |
  while IFS= read -r -d '' f; do
    rel="${f#"$ROOT"/}"
    mkdir -p "$WT/$(dirname "$rel")"
    cp "$f" "$WT/$rel"
  done

# 提交并推送
( cd "$WT" && git add -f -A && \
  if git diff --cached --quiet; then
    echo "==> -ruby.md 無變化，無需提交"
  else
    git commit -m "同步 -ruby.md（$(date +%F)）" >/dev/null
    git push -u origin site-src
    echo "==> 已推送到 site-src"
  fi )

git worktree remove "$WT" --force
echo "==> 完成"
