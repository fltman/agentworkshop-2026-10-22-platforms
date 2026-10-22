#!/usr/bin/env bash
# Release tool for the workshop lead: review, merge and deploy the teams' PRs.
# Needs gh (logged in) and ssh to the server. The repo is read from origin, nothing is written in here.
#
#   tools/release.sh list                 open PRs: team, files, age, and who has waited longest
#   tools/release.sh stale [minutes]      PRs open longer than that (default 60), oldest first   (also: glomda)
#   tools/release.sh check <nr>           rule check of a PR: allowed paths, secrets, tests if the server is touched. Exit 0 = ok
#   tools/release.sh diff <nr>            show the diff
#   tools/release.sh merge <nr>           squash-merge (runs check first)
#   tools/release.sh round                the whole round: check + risk scan + merge + one deploy + report   (also: varv)
#   tools/release.sh deploy               git pull on main + deploy/deploy.sh + health check
#   tools/release.sh announce <text>      post in #build as the release round
#
# SEVERAL PEOPLE SHOULD RUN IT. The merge queue must not hang on a single human: last time two PRs were
# never merged because the person running release was busy.
#
# But be honest about what the lock does: THE LOCK IN TMPDIR ONLY PROTECTS AGAINST TWO ROUNDS ON THE SAME
# COMPUTER. On separate laptops you never see each other's locks. So the round also takes a short-lived
# claim where the PRs already live: it assigns the PR to itself on GitHub (assignee) while working on it,
# skips what someone else is holding right now, and releases the claim as soon as the PR is done, whatever
# the outcome. A claim that stays (a round that died halfway) shows up in stale; remove it by hand.
# If the script can't assign (missing permission) it merges anyway, and then the simple rule applies:
# split by PR number, even and odd, and say who takes which in #build.
#
# Person number two needs three things in their own clone: merge rights in the repo, an ssh key the server
# lets in, and the file .deploy-host (see deploy/README.md). Without .deploy-host the deploy stops.
#
# Rules: a PR may only touch projects/<team>/**, board/plugins/<team>/** (backend)
# and board/public/colony/<team>/** (frontend, the team's tile in the colony).
# Everything else (board/server.js, tools/, .claude/, .github/, README ...) needs a human yes: check answers exit 2.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${REPO:-$(git remote get-url origin 2>/dev/null | sed -E 's#^git@github\.com:##; s#^https://github\.com/##; s#\.git$##')}"
case "$REPO" in */*) ;; *) echo "Can't tell which GitHub repo origin points to. Set REPO=<account>/<repo>." >&2; exit 2;; esac
ETIKETT=waiting-for-lead

# ALWAYS run in a separate clone. PR checkouts and branch switches must never touch the working directory
# where the lead or their agents have uncommitted changes, and a deploy from here is exactly what is on origin/main.
if [ -z "${RELEASE_KLON:-}" ]; then
  KLON="${RELEASE_KLON_DIR:-$HOME/.cache/${REPO#*/}-release}"
  [ -d "$KLON/.git" ] || { mkdir -p "$(dirname "$KLON")"; git clone -q "https://github.com/$REPO.git" "$KLON"; }
  git -C "$KLON" checkout -q main 2>/dev/null || true
  git -C "$KLON" reset -q --hard 2>/dev/null || true
  git -C "$KLON" pull -q --ff-only origin main
  for f in .board-name .board-url .deploy-host; do [ -f "$f" ] && cp "$f" "$KLON/$f"; done
  RELEASE_KLON=1 exec "$KLON/tools/release.sh" "$@"
fi
cmd="${1:-list}"; shift || true
case "$cmd" in round) cmd=varv;; stale) cmd=glomda;; esac

files_of() { gh pr view "$1" -R "$REPO" --json files -q '.files[].path'; }
team_of()  { gh pr view "$1" -R "$REPO" --json headRefName -q '.headRefName' | sed -E 's|^team/||; s|[^a-zåäö0-9-].*||'; }
alder()    { # minutes since the timestamp in $1 (ISO 8601)
  python3 -c "import datetime,sys; t=datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00')); print(int((datetime.datetime.now(datetime.timezone.utc)-t).total_seconds()//60))" "$1" 2>/dev/null || echo 0
}
# Claim on a single PR, shared between computers: assignee on GitHub. Answer: 0 = yours, 1 = someone else's.
# If the call fails (no permission, network down) it answers 0: the queue must not stop because of a lock.
ta_pr() { # ta_pr <nr>
  local nr="$1" agare
  JAG="${JAG:-$(gh api user -q .login 2>/dev/null || echo "")}"
  [ -n "$JAG" ] || return 0
  agare=$(gh pr view "$nr" -R "$REPO" --json assignees -q '.assignees[].login' 2>/dev/null | head -1 || echo "")
  if [ -n "$agare" ] && [ "$agare" != "$JAG" ]; then
    echo "  #$nr is being handled by $agare right now, skipping it this time"; return 1
  fi
  [ -n "$agare" ] || gh pr edit "$nr" -R "$REPO" --add-assignee "$JAG" >/dev/null 2>&1 || true
  return 0
}
# Release the claim as soon as the PR is done, whatever the outcome. A claim left behind would lock the
# other release person out forever, which would be worse than no claim at all.
slapp_pr() { [ -n "${JAG:-}" ] && gh pr edit "$1" -R "$REPO" --remove-assignee "$JAG" >/dev/null 2>&1 || true; }
# Mark a PR as set aside, on GitHub so that it survives the round and is visible to everyone running release.
markera() {
  gh pr edit "$1" -R "$REPO" --add-label "$ETIKETT" >/dev/null 2>&1 && return 0
  gh label create "$ETIKETT" -R "$REPO" -c FFB454 \
     -d "Set aside by the release round, a human must look at it" >/dev/null 2>&1 || true
  gh pr edit "$1" -R "$REPO" --add-label "$ETIKETT" >/dev/null 2>&1 || true
}
las_ta() {   # local lock: protects against two rounds on the SAME computer, not against two computers
  LAS="${TMPDIR:-/tmp}/release-${REPO#*/}.las"
  if mkdir "$LAS" 2>/dev/null; then echo "${RELEASE_VEM:-$(whoami)} $(date +%s)" > "$LAS/vem"; trap 'rm -rf "$LAS"' EXIT; return 0; fi
  vem=$(cut -d' ' -f1 "$LAS/vem" 2>/dev/null || echo "someone")
  nar=$(cut -d' ' -f2 "$LAS/vem" 2>/dev/null || echo 0)
  min=$(( ( $(date +%s) - ${nar:-0} ) / 60 ))
  if [ "$min" -gt 15 ]; then echo "(breaking a $min minute old lock from $vem)"; rm -rf "$LAS"; las_ta; return $?; fi
  echo "A release round is already running: $vem started $min minute(s) ago. Wait, or take another PR by hand." >&2
  exit 3
}

case "$cmd" in
  list)
    # Age counts from createdAt: a PR the team keeps polishing would otherwise look fresh however long it waited.
    gh pr list -R "$REPO" --json number,title,headRefName,author,files,createdAt \
      -q '.[] | [.number, .title, .headRefName, .author.login, (.files|length), .createdAt] | @tsv' |
    while IFS=$'\t' read -r nr titel gren vem antal uppdaterad; do
      m=$(alder "$uppdaterad")
      flagga=""; [ "$m" -ge 60 ] && flagga="   ← open for $m min"
      printf '#%-4s %-52s [%s] %s  %s files  %s min%s\n' "$nr" "$(printf %.52s "$titel")" "$gren" "$vem" "$antal" "$m" "$flagga"
    done
    ;;
  glomda)
    # Age counts from createdAt, not updatedAt. A team that polishes its PR while waiting makes it "fresh"
    # every time, and then it is never listed. That is exactly how PR #43 disappeared last time: the team
    # updated it four times between 11:51 and 13:09 and it still never got into main.
    # Labelled PRs (waiting-for-lead) are always listed, whatever their age: they are set aside by definition.
    # Labels and assignees can be empty, and tab is an IFS whitespace: two tabs in a row count as ONE
    # separator, so empty fields in the middle of the line would shift the rest. Hence "-".
    grans="${1:-60}"; hittade=0
    while IFS=$'\t' read -r nr titel gren skapad etiketter innehavare; do
      m=$(alder "$skapad")
      case "$etiketter" in *"$ETIKETT"*|*vantar-pa-ledaren*) markt=" · WAITING FOR THE LEAD";; *) markt="";; esac
      [ "$innehavare" = "-" ] || markt="$markt · claim still held by $innehavare"
      [ "$m" -lt "$grans" ] && [ -z "$markt" ] && continue
      hittade=$((hittade+1)); printf '#%-4s %-52s [%s]  open for %s min%s\n' "$nr" "$(printf %.52s "$titel")" "$gren" "$m" "$markt"
    done < <(gh pr list -R "$REPO" --json number,title,headRefName,createdAt,labels,assignees \
               -q '.[] | [.number, .title, .headRefName, .createdAt,
                          (([.labels[].name] | join(",")) as $l | if $l == "" then "-" else $l end),
                          (([.assignees[].login] | join(",")) as $a | if $a == "" then "-" else $a end)] | @tsv' \
             | sort -t'	' -k4,4)
    # The last command must not be a test: "[ x -eq 0 ] && echo" answers 1 when something WAS found, and
    # the round runs it in a pipe under set -e + pipefail. A successful round then ended with exit 1.
    [ "$hittade" -eq 0 ] && echo "No forgotten PRs. The queue is empty or fresh." || true
    ;;
  diff) gh pr diff "$1" -R "$REPO";;
  check)
    nr="${1:?pr number}"; team=$(team_of "$nr"); bad=0; needs_ok=0
    echo "PR #$nr  team: ${team:-?}"
    while IFS= read -r f; do
      case "$f" in
        projects/"$team"/*|board/plugins/"$team"/*|board/public/colony/"$team"/*) echo "  ok       $f";;
        projects/*|board/plugins/*|board/public/colony/*) echo "  OTHER TEAM'S FILE  $f"; bad=1;;
        *) echo "  shared   $f"; needs_ok=1;;
      esac
    done < <(files_of "$nr")
    # secrets in the diff. The added lines are read once into a variable and searched with here-strings: a
    # "grep | grep -q" under pipefail can report a miss when the last grep exits early.
    added="$(gh pr diff "$nr" -R "$REPO" | grep -E '^\+' || true)"
    if grep -qE 'sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[bp]-|-----BEGIN [A-Z ]*PRIVATE KEY|OPENROUTER_API_KEY=|ANTHROPIC_API_KEY=' <<<"$added"; then
      echo "  SECRET in the diff"; bad=1
    fi
    # keys in a query or an XML login (Trafiklab, Trafikverket and similar hex keys)
    if grep -qiE 'authenticationkey="[0-9a-f]{20,}|[?&](key|apikey|api_key|accessid)=[0-9a-f-]{20,}' <<<"$added"; then
      echo "  SECRET in the diff (an API key in a URL or a login element)"; bad=1
    fi
    # keys the lead handed out in the room: one value per line in a file that only exists on the lead's computer
    secrets_file="${RELEASE_SECRETS:-$HOME/.config/workshopladan/secrets.txt}"
    if [ -s "$secrets_file" ]; then
      known="$(grep -vE '^[[:space:]]*(#|$)' "$secrets_file" || true)"
      if [ -n "$known" ] && grep -qF -- "$known" <<<"$added"; then
        echo "  SECRET in the diff (a key the lead handed out)"; bad=1
      fi
    fi
    # server touched → tests
    if files_of "$nr" | grep -q '^board/'; then
      echo "  board/ is touched → running the tests against the PR branch (the server loads plugins)"
      gh pr checkout "$nr" -R "$REPO" >/dev/null 2>&1 || true
      # Hard time limit and output to a file: a test server that survives a failed test otherwise keeps the pipe open forever.
      ut=$(mktemp); rc=0; (cd board && perl -e 'alarm 90; exec @ARGV' node test.mjs > "$ut" 2>&1) || rc=$?
      # Only this clone's test server: rounds for other groups may be testing at the same time.
      pkill -f "$(pwd)/board/server.js" 2>/dev/null || true
      tail -1 "$ut"; [ $rc -eq 0 ] || { echo "  TESTS FAILED or hung (exit $rc):"; grep -E "✗|Error|error" "$ut" | head -5; bad=1; }
      git checkout -q main
    fi
    [ $bad -eq 1 ] && { echo "RESULT: stop"; exit 1; }
    [ $needs_ok -eq 1 ] && { echo "RESULT: needs the lead's ok (shared files)"; exit 2; }
    echo "RESULT: ok"
    ;;
  merge)
    nr="${1:?pr number}"; las_ta
    tools/release.sh check "$nr" || { rc=$?; [ $rc -eq 2 ] && [ "${FORCE:-}" = 1 ] || exit $rc; }
    gh pr merge "$nr" -R "$REPO" --squash --delete-branch
    echo "merged: #$nr"
    ;;
  deploy)
    git checkout -q main && git pull -q --ff-only origin main
    [ -f .deploy-host ] || [ -n "${HOST:-}" ] || {
      echo "No .deploy-host in $(pwd). The deploy can't run." >&2
      echo "Write it once:  printf 'root@<server-ip>\\n' > \$(git rev-parse --show-toplevel)/.deploy-host" >&2
      echo "in the clone you run release from, and it is copied here automatically next round." >&2
      exit 2; }
    deploy/deploy.sh 2>&1 | tail -2
    curl -sS --max-time 10 "$( [ -f .board-url ] && tr -d '[:space:]' < .board-url || echo '' )/api/health"; echo
    ;;
  varv)
    las_ta
    RISK='while ?\(true|for ?\(;;|process\.(exit|kill|abort)|child_process|eval\(|new Function|\.\./\.\.|unlinkSync|rmSync|rmdirSync|require\(.(http|https|net|dgram|cluster|worker_threads|vm).\)'
    mergade=(); vantar=(); stoppade=()
    for nr in $(gh pr list -R "$REPO" --json number -q '.[].number' | sort -n); do
      git checkout -q main 2>/dev/null; git pull -q --ff-only origin main 2>/dev/null || true
      titel=$(gh pr view "$nr" -R "$REPO" --json title -q .title | cut -c1-70)
      ta_pr "$nr" || continue        # someone else already took this PR
      rc=0; tools/release.sh check "$nr" > "${TMPDIR:-/tmp}/chk-${REPO#*/}-$nr.txt" 2>&1 || rc=$?; git checkout -q main 2>/dev/null || true
      # The "waiting for the lead" pile must survive the round, otherwise a PR once set aside drops out of
      # sight and nobody sees it again. The label sits on the PR, not in this script.
      if [ $rc -eq 2 ]; then markera "$nr"; slapp_pr "$nr"; vantar+=("#$nr $titel — shared files, read the diff yourself"); continue; fi
      if [ $rc -ne 0 ]; then slapp_pr "$nr"; stoppade+=("#$nr $titel — $( (grep -E "OTHER TEAM|SECRET|FAILED" "${TMPDIR:-/tmp}/chk-${REPO#*/}-$nr.txt" || true) | head -2 | tr '\n' ' ')"); continue; fi
      traff=$(gh pr diff "$nr" -R "$REPO" | awk '/^diff --git a\/board\//{p=1} /^diff --git a\/projects\//{p=0} p' | grep -E '^\+' | grep -nE "$RISK" | cut -c1-140 | head -3 || true)
      if [ -n "$traff" ]; then markera "$nr"; slapp_pr "$nr"; vantar+=("#$nr $titel — risk pattern, read it yourself: $traff"); continue; fi
      if ! gh pr merge "$nr" -R "$REPO" --squash > "${TMPDIR:-/tmp}/m-${REPO#*/}-$nr.txt" 2>&1; then
        if grep -qi conflict "${TMPDIR:-/tmp}/m-${REPO#*/}-$nr.txt"; then
          gh pr checkout "$nr" -R "$REPO" >/dev/null 2>&1 && git fetch -q origin main && git merge -q -X ours --no-edit origin/main >/dev/null 2>&1 && git push -q 2>/dev/null
          git checkout -q main; sleep 5
          gh pr merge "$nr" -R "$REPO" --squash > "${TMPDIR:-/tmp}/m-${REPO#*/}-$nr.txt" 2>&1 || { slapp_pr "$nr"; stoppade+=("#$nr $titel — conflict that could not be synced"); continue; }
        else slapp_pr "$nr"; stoppade+=("#$nr $titel — $(tail -1 "${TMPDIR:-/tmp}/m-${REPO#*/}-$nr.txt" | cut -c1-100)"); continue; fi
      fi
      gh pr edit "$nr" -R "$REPO" --remove-label "$ETIKETT" >/dev/null 2>&1 || true
      gh pr edit "$nr" -R "$REPO" --remove-label vantar-pa-ledaren >/dev/null 2>&1 || true
      slapp_pr "$nr"
      mergade+=("#$nr $titel")
    done
    git checkout -q main 2>/dev/null
    # The deploy must not kill the round. It used to end the whole round with exit 2 when .deploy-host was
    # missing, and then the report below was never printed — the only place where FORGOTTEN shows up.
    if [ ${#mergade[@]} -gt 0 ]; then
      tools/release.sh deploy | tail -1 || echo "DEPLOY FAILED, see above. What was merged is on main but not on the server."
    fi
    echo "MERGED (${#mergade[@]}):"; printf '  %s\n' "${mergade[@]:-none}"
    echo "WAITING FOR THE LEAD (${#vantar[@]}):"; printf '  %s\n' "${vantar[@]:-none}"
    echo "STOPPED (${#stoppade[@]}):"; printf '  %s\n' "${stoppade[@]:-none}"
    echo "FORGOTTEN (open for an hour or more, and everything labelled $ETIKETT):"
    tools/release.sh glomda 60 | sed 's/^/  /'
    ;;
  announce)
    BOARD_NAME=release tools/board.sh post build "$*"
    ;;
  *) sed -n '2,30p' "$0"; exit 2;;
esac
