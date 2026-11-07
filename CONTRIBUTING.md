# Contributing

Thanks for taking a look. This is a small project: one Worker, one HTML page, no build step and no dependencies to install.

## Run it locally

```bash
git clone https://github.com/elor79/global-fault-lines
cd global-fault-lines
npx wrangler@latest dev --port 8787 --test-scheduled
```

Open <http://localhost:8787>. KV is simulated locally, so no `wrangler login` and no Cloudflare account are needed to develop.

To exercise the alarm cron:

```bash
curl "http://localhost:8787/__scheduled?cron=*/15+*+*+*+*"   # returns immediately
sleep 100 && curl http://localhost:8787/alarms               # the run itself takes ~90 s
```

## Things that will confuse you first

These are real upstream behaviours, verified against the live APIs. None of them is a bug in this repo.

- **GDELT rate-limits per IP and signals it with HTTP 200.** The body is plain text (`Please limit requests to one every 5 seconds…`) with `Content-Type: application/json`, so status alone cannot detect it. Some cloud, CI and VPN egress IPs are blocked outright — the GDELT chip stays red there no matter what you do, while the same code works from a home connection. Test GDELT changes from a normal network.
- **GDELT allows one request per 5 seconds.** The page paces at 5.6 s per region, so a cold load of all 16 regions takes about two minutes. That is expected, not a hang.
- **The VIEWS `cm/sb` endpoint ignores country filters.** `?iso=804`, `?isoab=UKR` and no filter at all return the same 6876 rows across 7 pages. The page paginates and filters client-side.
- **VIEWS has no Palestine entity.** Gaza's forecast reflects Israel (`ISR`) only.
- **`localStorage` is a hard ~5 MB budget**, and `store.set` deliberately swallows `QuotaExceededError`. Cache parsed results, never raw API payloads — caching raw Polymarket responses once filled 3.3 MB and silently evicted everything else.

## House style

- No build step, no framework, no package manager. Keep it that way: the page must stay usable as a standalone file.
- The alarm rules in `worker.js` and the page's `LIVE-PURE` block are deliberate mirrors of each other. **Change both**, or the cron and the page will disagree.
- Prefer a narrow fix with a comment explaining *why* over a clever refactor.
- Never swallow an error silently. An empty `catch {}` or `onError(){}` hid three separate real bugs in this codebase: a 403 on `/alarms`, a `localStorage` overflow and a 404 on the Earth texture. Log it, or surface it in the UI.

## Good first contributions

- **Regions.** Add a hotspot to `data[]` in the page and `REGIONS` in `worker.js`. Needs a GDELT query, a Polymarket search term and a matching regex. Check for false positives: `/congo/` once matched a Republic of the Congo election market and could have raised a false alarm.
- **Market matching.** Three regions (Myanmar, Haiti, South China Sea) currently resolve to no usable market. Better search terms would help.
- **Alarm rules.** The thresholds in `evaluateAlarms` are documented guesses. Backtesting them against historical GDELT data would be genuinely valuable.
- **Accessibility.** The globe is WebGL-only; the region list and detail panel could carry the same information for keyboard and screen-reader users.

## Pull requests

State what you changed and how you verified it against the live APIs. If a change affects the alarm rules, say what it would have fired on and what it would have suppressed.

Please don't commit a real KV namespace id, an ntfy topic or any secret. `wrangler.toml` ships a placeholder id on purpose.

## Scope

This is a derived news and market signal, **not an official warning system**. Changes that present it as authoritative, add automated action on alarms, or imply certainty the data cannot support are out of scope.
