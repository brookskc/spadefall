# spadefall-turn

Mints short-lived Cloudflare TURN credentials so browsers behind symmetric NAT
or a restrictive corporate firewall can still reach a match. The long-lived
TURN API token stays in the Worker's secret store and never reaches a client.
The same deployment accepts strictly bounded anonymous game-health counters at
`/diagnostics` and writes them to the `GAME_ANALYTICS` Analytics Engine dataset.

## Deploy

```
cd worker
npx wrangler login
npx wrangler secret put TURN_API_TOKEN   # paste the API token from the dashboard
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL. Put that URL, with the `/ice` path,
into `ICE_ENDPOINT` at the top of `../src/net.js`.

## Check it

```
curl https://spadefall-turn.<your-subdomain>.workers.dev/ice
```

The endpoint only answers CORS requests from the production site, Pages
deployments, and the listed local development origins. A successful request
returns an `iceServers` array containing `stun:` and `turn:` URLs plus a
`username` and `credential`. A 502 means the upstream credential service is
unavailable; a missing secret or rate-limit binding returns 500.

## Notes

- Credentials live 2 hours, comfortably longer than the 12-minute CTF
  regulation. Each browser receives a separate credential; the game caches it
  locally for one hour.
- `ALLOWED_ORIGINS` rejects requests from unexpected browser origins. It is a
  traffic guard, not authentication: non-browser clients can forge an Origin
  header. The `TURN_RATE_LIMITER` binding therefore also caps minting per
  source address. For stronger guarantees, put an account/session service in
  front of this endpoint.
- Rotating the key: create a new TURN key in the dashboard, update
  `DEFAULT_TURN_KEY_ID` (or provide `TURN_KEY_ID` as a Worker variable), re-run
  `wrangler secret put`, and redeploy.
- Diagnostics accept only fixed enums and coarse numeric buckets. The Worker
  uses source addresses only for edge rate limiting and never writes them to
  the analytics dataset. Callsigns, chat, room data, positions, raw URLs, raw
  errors, and persistent identifiers are rejected by the payload schema.
