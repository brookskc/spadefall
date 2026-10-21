# Human gameplay analytics

The production browser sends one anonymous local-human summary when a played
round finishes, is abandoned, or is superseded by another round. Match resumes
do not create another record. Each human reports their own actions; the host's
bot actions and other humans are not rolled into their report. QA URLs, local
servers, and preview deployments do not send gameplay summaries.

Players can disable collection under **display & accessibility → anonymous
gameplay stats**. Browser Do Not Track and Global Privacy Control also disable
these summaries. There are no cookies or persistent identifiers for analytics.
The public privacy notice describes the actual fields.

## Collection and limits

`src/human-analytics.js` holds the fixed schema. `worker/src/index.js` independently
rejects extra fields, oversized payloads, invalid values, and rate-limited
requests. The existing `GAME_ANALYTICS` binding stores summaries in
`spadefall_game_health`, indexed by `human_round`. Build `human-v1` identifies
this schema. The one deployment-verification record uses `qa-setup` and must
never appear in gameplay reports.

Blob columns: build, mode, map index, network context, outcome, win/loss/unknown,
first action. Double columns follow `HUMAN_METRICS` in its exact declared order:

1. Visible active play seconds (menus and background tabs excluded)
2. Round clock seconds (may include time before a late join)
3. Local human kills
4. Local human deaths
5. Local human deaths within three seconds of spawning
6. Assists
7. Contribution points
8. Objective contribution
9. Shots
10. Successful digging actions
11. Successful placement actions
12. Grenades
13. Tactical pings
14. Airstrikes
15. Humans present at match entry
16. Bots present at match entry
17. Rifle equipped time while alive
18. SMG equipped time while alive
19. Sniper equipped time while alive

A human can submit multiple player-rounds and cannot be deduplicated across
rounds. Completed player-rounds are not distinct room matches. Do not report
these as unique players, retention, or daily/weekly active users. A lost browser
process or unavailable network can lose a summary. Metrics are client-reported;
CORS and rate limits are not proof that a request came from a human. Weapon-time
and play-time counters accumulate foreground rendered time, capped at one
second per frame to exclude long stalls. The summaries are unsampled in the
browser; Cloudflare may sample at scale, so SQL uses `_sample_interval` weights.

## Weekly report

Run `node scripts/weekly-analytics.mjs` to execute `docs/analytics-weekly.sql` against the private Analytics Engine dataset. The read-only credential is stored outside this repository in `~/.config/spadefall/analytics-token` with file mode 600; never print it or commit it.
Report the last seven days, grouped by mode/map/outcome. Include player-round
counts, completion versus abandonment, average active play time, completed
round clock averages, digging/building actions per player-round, weapon-time
shares, kills/deaths, spawn-death share, and objective contribution. Separate
network failures and superseded rounds. Keep recommendations proportional to
the sample size; a small count is not evidence of a trend. Zero rows means no
reported rounds, not zero visits or zero people playing.

Map indices: 0 Greenbelt, 1 Beachhead, 2 Pinefall, 3 Dunes, 4 Crown, 5 Caldera,
6 Foundry, 7 Faultline. Confirm `MAPS` if this catalogue changes.

The digest recipient and weekly schedule are configured privately in the chat
automation; it uses the connected Gmail account and private
Cloudflare access. Do not publish analytics in the public repository. If access
expires, ask for sign-in and do not invent or email stale data as a fresh report.
