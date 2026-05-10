# Host-side systemd units

Units that live on the prod host alongside the docker-compose stack.
They are NOT part of any compose service; install them at the systemd
level on the box.

## gg-docker-cleanup.timer

Runs daily at 03:30 UTC and prunes:

  - Buildx cache trimmed to <= 10 GB (preserves recent layers for
    fast incremental rebuilds; sweeps the rest).
  - All dangling and unreferenced docker images.

This exists because every `docker compose build` of portal-api or
portal-web produces ~2 GB of new layers, and Docker doesn't garbage-
collect them on its own. Without this timer the host disk fills up
within a couple of weeks of active development. It came up multiple
times in 2026-04 / 2026-05 before getting wired in properly.

The compose stack uses `restart: unless-stopped`, so every legitimate
image stays referenced by a running container -- `image prune -af`
only touches leftovers. Safe to run while the stack is live.

## Install on a new host

```sh
sudo cp infra/systemd/gg-docker-cleanup.service /etc/systemd/system/
sudo cp infra/systemd/gg-docker-cleanup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gg-docker-cleanup.timer
systemctl list-timers gg-docker-cleanup.timer
```

## Run once on demand

```sh
sudo systemctl start gg-docker-cleanup.service
journalctl -u gg-docker-cleanup.service -n 50
```
