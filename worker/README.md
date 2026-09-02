# spadefall-turn

Mints short-lived Cloudflare TURN credentials so browsers behind symmetric NAT
or a restrictive corporate firewall can still reach a match. The long-lived
TURN API token stays in the Worker's secret store and never reaches a client.

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

Expect JSON with an `iceServers` array containing `stun:` and `turn:` URLs plus
a `username` and `credential`. A 502 means the API token is wrong or unset.

## Notes

- Credentials live 2 hours, comfortably longer than the 12-minute CTF
  regulation, and are cached per isolate to avoid an upstream call per load.
- `ALLOWED_ORIGINS` in `src/index.js` gates CORS. Add any new origin there.
- Rotating the key: create a new TURN key in the dashboard, update
  `TURN_KEY_ID`, re-run `wrangler secret put`, redeploy.
