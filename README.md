```
  ██████╗ ██████╗
 ██╔════╝ ██╔══██╗
 ██║  ███╗██████╔╝
 ██║   ██║██╔══██╗
 ╚██████╔╝██║  ██║
  ╚═════╝ ╚═╝  ╚═╝
  ·  g r o k   r e m o t e  ·  v0.1.0
```

# grok-remote

Run your **grok agent** on one machine. Reach it from any device on your **tailnet**. One command sets it up, PM2 keeps it alive, Tailscale handles the networking.

Right now this is a hello-world surface. The remote-agent endpoints (`/api/agent/*` wrapping `grok agent stdio`) land in the next build.

> Not affiliated with xAI, grok, or Tailscale.

## What you get

- **One-shot install.** `./install.sh` verifies Node, installs PM2 + Tailscale (if missing), brings up the daemon, resolves your tailnet URL, builds the dashboard, starts under PM2, and prints the URL you can hit from anywhere on your tailnet.
- **PM2-managed.** Survives crashes, restarts on boot (after `pm2 save && pm2 startup`).
- **Tailscale-fronted.** No port forwarding, no public IP, no DNS to manage. The dashboard binds locally; Tailscale brings it to your devices.
- **Vite dashboard.** Dark terminal aesthetic. Pings `/api/hello` and shows you the tailnet state.

## Requirements

- macOS or Linux
- Node.js 20+ (the installer can install it via Homebrew on macOS)
- Homebrew (macOS only, used to install Tailscale + Node when missing)
- A Tailscale account (free for personal use at [tailscale.com](https://tailscale.com))

## Install

```sh
git clone https://github.com/<you>/grok-remote.git
cd grok-remote
./install.sh
```

The installer walks through, in order:

1. verify node >= 20
2. ensure pm2 (process manager)
3. ensure tailscale
4. start tailscaled (daemon)
5. check tailscale auth
6. resolve tailnet url
7. install app dependencies (npm install)
8. build dashboard (vite build)
9. write pm2 ecosystem config
10. start under pm2
11. save pm2 process list

If a step warns about Tailscale auth, run `tailscale up` and open the URL it prints. On macOS, open Tailscale.app once if `tailscaled` is not running. Then re-run `./install.sh`.

## Use

Once installed, hit the URL the installer printed. Looks like:

```
http://your-host.tail-scale.ts.net:7910
```

Reachable from any device on your tailnet. The dashboard pings `/api/hello` every five seconds and shows the tailnet state.

## Manage

```sh
pm2 logs grok-remote       # follow logs
pm2 status                 # all PM2 processes
pm2 restart grok-remote    # restart
pm2 stop grok-remote       # stop
pm2 delete grok-remote     # remove from PM2
```

To make it survive reboot:

```sh
pm2 save
pm2 startup           # follow the instructions it prints
```

## Develop

```sh
npm install
npm start             # backend on :7910
npm run dev           # Vite dev server on :7911 (proxies /api to 7910)
```

Edit `src/main.js` and `src/style.css` for the UI. Edit `server.js` for the API. The `/api/hello` endpoint is the seed for everything that comes next.

## Layout

```
grok-remote/
├── install.sh             # bash bootstrap (verifies Node, hands off to installer.js)
├── installer.js           # animated installer with the real work
├── server.js              # Node http server, serves dist/ + /api/*
├── ecosystem.config.cjs   # PM2 config
├── vite.config.js         # Vite config (dev port 7911, proxies /api → 7910)
├── index.html             # dashboard entry
├── src/
│   ├── main.js            # dashboard logic + figlet reveal
│   └── style.css          # terminal-style theme
└── package.json
```

## What's next

- `POST /api/agent/start` — spawn `grok agent stdio` and stream output
- `WS /api/agent/ws` — keep a session warm, multiplex clients
- token auth so it isn't trivially open inside your tailnet
- per-session conversation history

## License

MIT. See [LICENSE](./LICENSE).
