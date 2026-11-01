# Using it from your phone (optional)

The server only listens on `127.0.0.1`, so nothing on your network can reach it.
To open it on your phone, put an authenticated tunnel in front of it.
[Tailscale](https://tailscale.com) is the tested option.

```sh
# on the computer running sg-stay-where (Tailscale installed and logged in)
tailscale serve --bg --https=8431 http://127.0.0.1:7431
tailscale serve status        # shows https://<machine>.<tailnet>.ts.net:8431
```

Then tell the server which host name and which Tailscale accounts to accept, in
`data/server.json`:

```json
{
  "remoteHosts": ["<machine>.<tailnet>.ts.net:8431"],
  "allowedLogins": ["you@example.com"]
}
```

Restart the server. Requests through `tailscale serve` carry the signed-in
user's login (`Tailscale-User-Login`); anyone not listed gets `403`. The app is
then reachable only by your own devices on your tailnet, not the internet.

Notes:

- Use `tailscale serve`, **not** `tailscale funnel` (Funnel publishes to the
  internet).
- The UI is built for phones: Review is a swipe deck, the map shrinks to the top.
- Any other tunnel that authenticates you works the same way; add its host to
  `remoteHosts`. Don't port-forward the raw server: it has no login of its own.
