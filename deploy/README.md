# Deploy

Production-oriented deployment artifacts live here. Local dev infra is in
`/infra` instead.

| Subdir | Purpose |
| --- | --- |
| `docker-compose/` | Pinned production Compose stack (single-host deploy) |
| `helm/` | Kubernetes Helm chart (future, Phase 8) |
| `installer/` | `get.gratisgis.org` bootstrap script |

See [../docs/deployment.md](../docs/deployment.md) for admin-facing docs.
