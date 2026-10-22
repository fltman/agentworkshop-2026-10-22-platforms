#!/usr/bin/env bash
# Deliver your team's work: fork, branch, commit, push and pull request in one command.
#
#   tools/pr.sh <team-name> "<one line about what you did>"
#
# Run it in the repo root, or as ../../tools/pr.sh in your team folder. Safe to run again: next time only
# the new work is pushed, and the PR updates by itself.
# Takes only your team's files: projects/<team>/, board/plugins/<team>/ and board/public/colony/<team>/.
# Needs the GitHub CLI: https://cli.github.com  and that you are logged in: gh auth login
#
# No participant can push to the workshop repo, so the way in is always fork + PR. That is why this script
# exists from the start: last time it was written in the middle of the day, and until then deliveries got stuck.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Upstream is the repo you cloned. No address is written here: it is read from origin.
UPSTREAM="${UPSTREAM:-$(git remote get-url origin 2>/dev/null | sed -E 's#^git@github\.com:##; s#^https://github\.com/##; s#\.git$##')}"
case "$UPSTREAM" in */*) ;; *) echo "Can't tell which GitHub repo origin points to. Set UPSTREAM=<account>/<repo> and run again." >&2; exit 2;; esac
REPONAMN="${UPSTREAM#*/}"
# The redirect must be tested first: "< .board-url" fails in the shell before tr starts, and 2>/dev/null
# on tr does not catch that. Without [ -f ] the first line the participant saw was a raw shell error.
BOARD=$( [ -f .board-url ] && tr -d '[:space:]' < .board-url || echo "" )

team="${1:-}"; vad="${2:-}"
[ -n "$team" ] && [ -n "$vad" ] || { echo "usage: tools/pr.sh <team-name> \"<what you did>\"" >&2; ls projects 2>/dev/null | grep -v README | sed 's/^/  team: /' >&2; exit 2; }
team=$(printf %s "$team" | tr 'A-ZÅÄÖ' 'a-zåäö' | tr -cs 'a-zåäö0-9' '-' | sed 's/^-//; s/-$//')
# Same list as new-team.sh and check-setup.sh read, so the three never drift apart.
if grep -v '^[[:space:]]*#' tools/upptagna-namn.txt 2>/dev/null | grep -qxF "$team"; then
  echo "\"$team\" is an example name in the documentation (or a reserved name) and is shared by several. Rename your folder first:" >&2
  echo "  mv projects/$team projects/<your-own-name>   (and board/plugins/$team, board/public/colony/$team if they exist)" >&2
  echo "  and change the line in .board-name, otherwise you keep posting under the old name." >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || { cat >&2 <<TXT
The GitHub CLI (gh) is missing. Install it from https://cli.github.com and run: gh auth login
Without gh, by hand:
  1. Fork https://github.com/$UPSTREAM in the browser (the Fork button).
  2. git remote add fork https://github.com/<your-github-name>/$REPONAMN.git
  3. git checkout -b team/$team && git add projects/$team board/plugins/$team board/public/colony/$team && git commit -m "$team: $vad"
  4. git push -u fork team/$team
  5. Open https://github.com/$UPSTREAM/compare, choose "compare across forks", your branch team/$team against main.
TXT
exit 1; }
gh auth status >/dev/null 2>&1 || { echo "You are not logged in to the GitHub CLI. Run: gh auth login   (choose GitHub.com, HTTPS, log in with the browser)" >&2; exit 1; }
me=$(gh api user -q .login)

# 1. where do we push? the owner pushes to origin, everyone else to their fork
if [ "$me" = "${UPSTREAM%%/*}" ]; then remote=origin
else
  remote=fork
  if ! git remote get-url fork >/dev/null 2>&1; then
    echo "→ creating your fork $me/$REPONAMN (if it does not exist) and adding it as remote \"fork\""
    gh repo fork "$UPSTREAM" --clone=false >/dev/null 2>&1 || true
    git remote add fork "https://github.com/$me/$REPONAMN.git"
  fi
fi

# 2. branch
branch="team/$team"
if [ "$(git branch --show-current)" != "$branch" ]; then
  git show-ref --verify --quiet "refs/heads/$branch" && git checkout -q "$branch" || git checkout -q -b "$branch"
fi
echo "→ branch $branch"

# 3. only your files
# A path also counts if it is tracked in HEAD's tree, not just present on disk: a team that deletes its ENTIRE
# colony or plugin folder leaves nothing for [ -e ] to find, so the deletion was silently never staged
# (found and fixed by a team at the workshop on 2026-10-22).
tracked() { git ls-tree -r HEAD --name-only -- "$1" 2>/dev/null | grep -q .; }
paths=(); for p in "projects/$team" "board/plugins/$team" "board/public/colony/$team"; do
  { [ -e "$p" ] || tracked "$p"; } && paths+=("$p")
done
[ ${#paths[@]} -gt 0 ] || { echo "Found no files for team \"$team\". Does projects/$team/ or board/plugins/$team/ exist? The team name is the folder's name." >&2; exit 1; }
[ -e "board/plugins/$team/index.js" ] || echo "  note: no backend yet (board/plugins/$team/index.js). That is fine, but your tile can't listen to The Square without it."
[ -e "board/public/colony/$team/index.html" ] || echo "  note: no frontend yet (board/public/colony/$team/index.html). Then your team has no tile in the colony (/colony)."
git add -- "${paths[@]}"
if git diff --cached --quiet; then echo "→ nothing new to commit"; else git commit -q -m "$team: $vad" && echo "→ committed"; fi
# The folder names end in / or the line: board/public/colony/<team>-map/ is NOT your folder and must be reported.
andra=$(git status --porcelain | grep -v "^?? \.board-name" | grep -vE " (projects/$team|board/plugins/$team|board/public/colony/$team)(/|$)" | head -5 || true)
if [ -n "$andra" ]; then
  echo "  note: these changes do NOT come along (outside your team's folders):"; echo "$andra" | sed 's/^/    /'
  if echo "$andra" | grep -q "board/public/colony/"; then
    echo "  note: each team has one tile, board/public/colony/$team/. Put extra pages inside it, for example"
    echo "        board/public/colony/$team/map.html, and link to them from your index.html."
  fi
fi

# 3b. Sync with main. Your PRs are squash-merged, so the branch diverges from main after every delivery and
#     the next PR would conflict with your own previous one. On conflict YOUR version wins: you are the only
#     ones touching your files.
if git fetch -q origin main 2>/dev/null; then
  if ! git merge -q -X ours --no-edit origin/main >/dev/null 2>&1; then
    git merge --abort 2>/dev/null || true
    echo "  note: could not sync with main automatically. Run: git stash; git merge -X ours origin/main; git stash pop   and then this command again."
  else echo "→ synced with main"; fi
fi

# 4. push
# git pushes over https with gh's login. Without a credential helper (common in a fresh WSL) git asks for a
# password it cannot read and stops with "unable to get password". gh auth setup-git wires gh in, once.
gh auth setup-git >/dev/null 2>&1 || true
echo "→ pushing to $remote"
# The branch lives only in your own fork, so if it was recreated locally (non-fast-forward), overwrite it there:
# --force-with-lease refuses if someone else pushed to it in the meantime.
if ! git push -q -u "$remote" "$branch" 2>/dev/null && ! git push -q -u --force-with-lease "$remote" "$branch"; then
  echo "Push to $remote failed. If git asked for a password: run  gh auth setup-git  and then this command again." >&2
  exit 1
fi

# 5. pull request (if it already exists, the push updated it)
head="$me:$branch"; [ "$remote" = origin ] && head="$branch"
ut=$(gh pr create -R "$UPSTREAM" --base main --head "$head" --title "$team: $vad" --body "Team **$team**: $vad

Created with tools/pr.sh. The release round reviews, merges and deploys it.${BOARD:+ Then your tile shows up at $BOARD/colony/$team}" 2>&1) && echo "→ PR created: $ut" || {
  url=$(printf %s "$ut" | grep -oE 'https://github.com/[^ ]+/pull/[0-9]+' | head -1)
  [ -n "$url" ] && echo "→ the PR already exists and now has what you just pushed: $url" || { echo "$ut" >&2; exit 1; }
}
echo
echo "Done. Say so in #build:  tools/board.sh post build \"PR in from $team: $vad\""
echo "The release round merges and deploys within a few minutes. Changed something? Run the same command again."
echo "Learned something another team could use? Share it:  tools/spore.sh announce \"<title>\" \"<lesson>\""
