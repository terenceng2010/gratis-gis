# Deployment

> **Design goal:** an IT admin with no prior GratisGIS experience should go
> from a fresh Ubuntu server to a working, HTTPS-enabled portal in under
> 30 minutes. Traditional self-hosted enterprise GIS stacks can take days or
> weeks to stand up; we can do better by being honest about the 80% case.

## The Three Deployment Modes

### 1. One-liner installer (recommended for small orgs)

```bash
curl -fsSL https://get.gratisgis.org | sudo bash -s -- \
  --domain portal.acme.org \
  --email admin@acme.org
```

What it does:

1. Verifies the host (Ubuntu 22.04+, Debian 12+, ≥ 4 CPU, ≥ 8 GB RAM, ≥ 40 GB disk).
2. Installs Docker Engine + Compose if missing.
3. Creates `/etc/gratisgis/` with a generated env file (strong random
   secrets for DB, Keycloak, MinIO, NextAuth).
4. Pulls the pinned release's compose file and images.
5. Starts the stack with Caddy fronting everything (auto-HTTPS via
   Let's Encrypt).
6. Runs DB migrations and seeds the Keycloak realm + first admin user.
7. Prints the admin URL and initial password to the terminal.

Post-install: a `gratisgis` CLI becomes available for upgrade, backup,
user management, and log tailing.

### 2. Docker Compose (manual)

For teams who want more control or are behind an internal proxy.

```bash
git clone https://github.com/<user>/gratis-gis.git
cd gratis-gis/deploy/docker-compose
cp .env.example .env   # edit passwords, domain
docker compose up -d
```

Same components as the one-liner but you own the box and the config.

### 3. Kubernetes (Helm chart)

For larger orgs that want HA, autoscaling, and existing cluster ops.

```bash
helm repo add gratisgis https://charts.gratisgis.org
helm install gratisgis gratisgis/gratis-gis \
  --namespace gratis-gis --create-namespace \
  -f my-values.yaml
```

The chart packages each service as a separate deployment, supports an
external Postgres (RDS, Cloud SQL, CNPG operator), external Keycloak, and
external object storage (S3/R2/GCS).

## What gets installed

Every mode deploys the same set of services:

- **portal-api**: the NestJS backend
- **portal-web**: the Next.js portal UI
- **postgres**: PostgreSQL 16 + PostGIS 3
- **keycloak**: identity
- **minio**: object storage (replaceable by S3-compatible external)
- **pg_tileserv**: tile server
- **caddy**: reverse proxy with automatic HTTPS
- **(later phases)** **tool-runner**, **scheduler**

## Sensible defaults philosophy

Every knob has a reasonable default:

- Database pool size scales with host CPU count
- Rate limits are set per-endpoint
- Backups (pg\_dump + MinIO snapshot) run nightly at 02:00 local time
- Log retention is 7 days by default; admin can change
- Email for password reset goes out via a hosted provider (configurable);
  installer accepts `--smtp-url` or uses a built-in relay for development

Admins can tune anything in `/etc/gratisgis/config.yml`, but they should
never *have* to.

## Upgrades

```bash
gratisgis upgrade                 # pulls pinned release, runs migrations
gratisgis upgrade --version 1.4.0 # pin a specific version
gratisgis rollback                # reverts to previous version
```

Migrations run inside a transaction; a failed migration auto-rolls-back and
leaves the previous version running. No "reinstall from scratch" scenarios.

## Backup & restore

```bash
gratisgis backup --to s3://acme-backups/gratisgis/
gratisgis restore --from s3://acme-backups/gratisgis/2026-04-17T02:00Z/
```

Backs up Postgres (dump), MinIO (snapshot), and Keycloak config. Restore is
tested in CI against each release.

## Observability out of the box

- `/metrics` endpoint on each service (Prometheus format)
- `gratisgis logs` tails all services; `gratisgis logs portal-api` filters
- Optional Grafana + Prometheus stack (`--with-monitoring` flag)

## Hardening checklist (automated)

The installer applies these by default:

- Non-root users inside every container
- Read-only rootfs where possible
- Internal services bound to the Docker network (not host ports)
- Caddy auto-renews certs
- Strong-random passwords (32 bytes) for every internal credential

## What we intentionally won't do

- Require a per-service license file
- Require a domain controller / Active Directory integration for core
  features (SSO is supported, but not required)
- Ship a 300-page admin guide as the price of admission
- Expose a hundred config knobs the admin has to fill in before anything
  works
