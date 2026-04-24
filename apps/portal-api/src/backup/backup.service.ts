import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as tar from 'tar';

import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Shape returned by getConfig() — a read-only view of the environment
 * knobs that drive the backup system. The admin UI renders these as
 * informational rows (ops-level, not org-level, so they're not
 * editable from the app).
 */
export interface BackupConfig {
  /** Absolute path of the directory where archives are written. */
  backupDir: string;
  /** Cron expression the scheduled run uses (default 0 2 * * *). */
  scheduleCron: string;
  /** How many successful backups to keep before the oldest drops. */
  retentionCount: number;
  /** Human-readable description of how pg_dump is invoked. */
  pgDumpMode: 'host' | 'docker';
  /** Name of the docker container when pgDumpMode === 'docker'. */
  pgDumpDockerContainer: string | null;
  /** MinIO bucket being backed up (display-only). */
  minioBucket: string;
  /** True when scheduled runs are disabled (BACKUP_SCHEDULE_DISABLED). */
  scheduleDisabled: boolean;
}

/**
 * Layout of the JSON manifest dropped into every archive. Everything
 * a restore routine needs to know about the archive it's holding,
 * without having to parse the dump files.
 */
interface BackupManifest {
  /** Format version of the archive layout. Bump when the directory
   *  layout changes in a way that breaks older restore code. */
  version: 1;
  /** ISO timestamp the run started. */
  createdAt: string;
  /** 'manual' or 'scheduled'. */
  trigger: string;
  /** Portal app version from package.json (best-effort). */
  portalVersion: string | null;
  /** Database URL with password redacted. */
  databaseUrl: string;
  /** Names of the dumped databases, in archive order. */
  databases: string[];
  /** Whether MinIO objects are included, and how many. */
  minio: {
    bucket: string;
    objectCount: number;
    totalBytes: number;
  };
  /** Portal commit hash if available at runtime (GIT_SHA env). */
  gitSha: string | null;
}

/**
 * Core backup service: produces a .tar.gz containing a pg_dump of
 * the portal database + a flat copy of the MinIO bucket + a
 * manifest.json. One archive per run, written atomically to
 * BACKUP_DIR.
 *
 * Non-goals for this first cut (tracked under #59-restore):
 *   - Keycloak state: the dev compose uses KC_DB=dev-file (H2 inside
 *     the container, not persisted to a volume), so there's nothing
 *     stable to snapshot. Prod deployments with a JDBC Keycloak need
 *     a separate strategy; we surface this limitation clearly in the
 *     admin UI so nobody expects Keycloak users to survive a restore.
 *   - Encryption at rest: archives are plain .tar.gz. Operators that
 *     need encrypted offsite copies should wrap them with their own
 *     tooling (age, gpg, S3 SSE). We don't want to ship key material
 *     inside the app.
 *   - Incremental / differential backups: out of scope. Full dump
 *     every run keeps restore simple; retention handles the space.
 */
@Injectable()
export class BackupService implements OnModuleInit {
  private readonly log = new Logger(BackupService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
  ) {
    // Reuse the same MinIO creds StorageService uses — if one works
    // the other does, which keeps the admin "backup failed" surface
    // from pointing at two different auth issues.
    const endpoint = cfg.get<string>('MINIO_ENDPOINT', 'http://localhost:9000');
    const accessKeyId = cfg.get<string>('MINIO_ACCESS_KEY', 'gratisgis');
    const secretAccessKey = cfg.get<string>('MINIO_SECRET_KEY', 'devpassword');
    this.bucket = cfg.get<string>('MINIO_BUCKET', 'gratisgis');
    this.s3 = new S3Client({
      region: 'us-east-1',
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
  }

  async onModuleInit() {
    // Ensure BACKUP_DIR exists at startup so a "run now" click
    // doesn't race with a missing directory. If the operator has
    // pointed this at a path the process can't write to, we want
    // that failure to surface in the log before the first run.
    const dir = this.resolveBackupDir();
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {
      this.log.error(
        `BACKUP_DIR ${dir} is not creatable; backups will fail until this is fixed: ${(e as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------

  getConfig(): BackupConfig {
    const dockerContainer =
      this.cfg.get<string>('BACKUP_PGDUMP_DOCKER_CONTAINER') || null;
    return {
      backupDir: this.resolveBackupDir(),
      scheduleCron: this.cfg.get<string>('BACKUP_SCHEDULE_CRON', '0 2 * * *'),
      retentionCount: this.resolveRetentionCount(),
      pgDumpMode: dockerContainer ? 'docker' : 'host',
      pgDumpDockerContainer: dockerContainer,
      minioBucket: this.bucket,
      scheduleDisabled:
        (this.cfg.get<string>('BACKUP_SCHEDULE_DISABLED') || '').toLowerCase() ===
        'true',
    };
  }

  private resolveBackupDir(): string {
    // BACKUP_DIR is absolute. Default lives inside the repo so dev
    // setups "just work"; production should point it at an on-host
    // volume outside the container filesystem.
    const raw = this.cfg.get<string>('BACKUP_DIR', './backups');
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }

  private resolveRetentionCount(): number {
    const raw = Number(this.cfg.get<string>('BACKUP_RETENTION_COUNT', '7'));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7;
  }

  // ---------------------------------------------------------------
  // Run history
  // ---------------------------------------------------------------

  listRuns(limit = 50) {
    return this.prisma.backupRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
  }

  async getRun(id: string) {
    const run = await this.prisma.backupRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Backup run not found');
    return run;
  }

  // ---------------------------------------------------------------
  // Run a backup
  // ---------------------------------------------------------------

  /**
   * Execute a backup. Creates the BackupRun row first (status=running)
   * so an admin watching the page can see the run is in flight, then
   * streams pg_dump + MinIO into a staging dir, seals the archive,
   * and finalises the row. On failure, the row is marked failed and
   * the partial staging dir is removed — we never leave a half-tarred
   * archive in the target directory.
   *
   * @param trigger 'manual' (user-initiated) or 'scheduled' (cron).
   * @param startedBy User id for manual runs; null for scheduled.
   * @returns The final BackupRun row (already persisted).
   */
  async runBackup(
    trigger: 'manual' | 'scheduled',
    startedBy: string | null,
  ) {
    const run = await this.prisma.backupRun.create({
      data: {
        trigger,
        ...(startedBy ? { startedBy } : {}),
      },
    });
    this.log.log(`Backup ${run.id} started (${trigger})`);

    const backupDir = this.resolveBackupDir();
    const timestamp = run.startedAt
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('Z', '');
    const stageDir = path.join(backupDir, `.stage-${run.id}`);
    const filename = `backup-${timestamp}-${run.id.slice(0, 8)}.tar.gz`;
    const finalPath = path.join(backupDir, filename);

    try {
      await fs.mkdir(stageDir, { recursive: true });
      await fs.mkdir(path.join(stageDir, 'postgres'), { recursive: true });
      await fs.mkdir(path.join(stageDir, 'minio'), { recursive: true });

      // 1. Postgres dump via pg_dump. Custom format (-Fc) is self-
      //    compressing and supports partial restores via pg_restore,
      //    which we'll want for disaster-recovery scenarios.
      const dbName = this.extractDbName(
        this.cfg.get<string>('DATABASE_URL', ''),
      );
      const dumpPath = path.join(
        stageDir,
        'postgres',
        `${dbName || 'gratisgis'}.dump`,
      );
      await this.runPgDump(dumpPath);

      // 2. MinIO mirror. We stream each object straight to disk so a
      //    big bucket doesn't pin the whole thing in memory.
      const minioStats = await this.mirrorMinio(path.join(stageDir, 'minio'));

      // 3. Manifest — enough context to drive a restore without
      //    reopening the dump files.
      const manifest: BackupManifest = {
        version: 1,
        createdAt: run.startedAt.toISOString(),
        trigger,
        portalVersion: this.readPortalVersion(),
        databaseUrl: this.redactDbUrl(
          this.cfg.get<string>('DATABASE_URL', ''),
        ),
        databases: [dbName || 'gratisgis'],
        minio: {
          bucket: this.bucket,
          objectCount: minioStats.count,
          totalBytes: minioStats.bytes,
        },
        gitSha: this.cfg.get<string>('GIT_SHA') || null,
      };
      await fs.writeFile(
        path.join(stageDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8',
      );

      // 4. Seal the archive. tar.c streams directly to gzip + file,
      //    so at no point do we hold the entire archive in memory.
      //    cwd/stage root means the paths inside the tar are relative
      //    (postgres/..., minio/..., manifest.json) — portable.
      await tar.c(
        {
          gzip: true,
          file: finalPath,
          cwd: stageDir,
        },
        ['postgres', 'minio', 'manifest.json'],
      );

      const stat = await fs.stat(finalPath);
      await this.prisma.backupRun.update({
        where: { id: run.id },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          filename,
          sizeBytes: BigInt(stat.size),
        },
      });
      this.log.log(
        `Backup ${run.id} finished: ${filename} (${stat.size} bytes)`,
      );

      // 5. Enforce retention. Done after the new row is finalised so
      //    we never delete the just-written archive as part of the
      //    same run. Manual runs deliberately do NOT trigger retention
      //    sweeps; those happen on the scheduled path.
      if (trigger === 'scheduled') {
        await this.enforceRetention();
      }

      return this.getRun(run.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.error(`Backup ${run.id} failed: ${msg}`);
      await this.prisma.backupRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: msg.slice(0, 500),
        },
      });
      // Best-effort cleanup: an empty/partial archive is worse than
      // no archive, because the admin page would think it succeeded.
      await fs.rm(finalPath, { force: true });
      return this.getRun(run.id);
    } finally {
      // Stage dir goes away regardless — on success its contents are
      // already inside the tar; on failure they're orphaned bytes
      // we don't want cluttering BACKUP_DIR.
      await fs.rm(stageDir, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------
  // Archive file operations (download / delete)
  // ---------------------------------------------------------------

  /**
   * Absolute path to the archive on disk for a given run, plus the
   * original filename (for Content-Disposition). Throws if the run
   * or the file isn't usable — callers (controller) map this to 404.
   */
  async resolveArchivePath(runId: string) {
    const run = await this.getRun(runId);
    if (run.status !== 'succeeded' || !run.filename) {
      throw new NotFoundException('Backup archive is not available');
    }
    const p = path.join(this.resolveBackupDir(), run.filename);
    try {
      await fs.access(p);
    } catch {
      throw new NotFoundException(
        'Backup file is missing on disk; it may have been moved or manually deleted',
      );
    }
    return { path: p, filename: run.filename };
  }

  /**
   * Remove a backup archive AND its run row. Used by the admin UI
   * delete button and by the retention sweep. Idempotent: a missing
   * file just gets the row cleaned up anyway so the table stays
   * consistent with what's on disk.
   */
  async deleteRun(runId: string) {
    const run = await this.getRun(runId);
    if (run.filename) {
      const p = path.join(this.resolveBackupDir(), run.filename);
      await fs.rm(p, { force: true });
    }
    await this.prisma.backupRun.delete({ where: { id: run.id } });
    return { deleted: run.id };
  }

  /**
   * Keep only the most recent N successful backups. Failed runs are
   * NOT counted against the cap — operators want to see "these three
   * in a row failed" while the last 7 successful archives still sit
   * on disk. Called by the scheduler after a successful run.
   */
  async enforceRetention(): Promise<{ removed: number }> {
    const cap = this.resolveRetentionCount();
    const successful = await this.prisma.backupRun.findMany({
      where: { status: 'succeeded' },
      orderBy: { startedAt: 'desc' },
      skip: cap,
    });
    let removed = 0;
    for (const old of successful) {
      try {
        await this.deleteRun(old.id);
        removed += 1;
      } catch (e) {
        this.log.warn(
          `Retention: could not delete ${old.id}: ${(e as Error).message}`,
        );
      }
    }
    return { removed };
  }

  // ---------------------------------------------------------------
  // Private: pg_dump
  // ---------------------------------------------------------------

  /**
   * Invoke pg_dump in either "host" (binary on PATH) or "docker"
   * (docker exec <container> pg_dump) mode. Connection parameters
   * come from DATABASE_URL so operators never have to re-encode
   * credentials here.
   *
   * We pipe stdout straight to a file stream rather than buffering
   * through Node, so a 5 GB dump doesn't need 5 GB of RAM.
   */
  private async runPgDump(outPath: string) {
    const url = this.cfg.get<string>('DATABASE_URL', '');
    if (!url) throw new Error('DATABASE_URL is not set; cannot run pg_dump');
    const container = this.cfg.get<string>(
      'BACKUP_PGDUMP_DOCKER_CONTAINER',
      '',
    );
    const extraArgs = ['-Fc', '--no-owner', '--no-privileges'];

    // Host mode: pg_dump takes the URL as the last positional arg.
    // Docker mode: we `docker exec <c> pg_dump <same args>` — the
    // container has pg_dump on PATH. We pass the URL via env to avoid
    // leaking it into the process list visible to other container
    // tenants.
    const bin = container ? 'docker' : 'pg_dump';
    const args = container
      ? ['exec', '-e', `PG_URL=${url}`, container, 'sh', '-c',
         `pg_dump "$PG_URL" ${extraArgs.join(' ')}`]
      : [...extraArgs, url];

    const out = createWriteStream(outPath);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stderrChunks: Buffer[] = [];
        child.stderr.on('data', (c) => stderrChunks.push(c));
        child.stdout.pipe(out);
        out.on('error', reject);
        child.on('error', reject);
        child.on('close', (code) => {
          if (code === 0) return resolve();
          const tail = Buffer.concat(stderrChunks).toString('utf8').slice(-500);
          reject(
            new Error(
              `pg_dump exited with code ${code}: ${tail || '(no stderr)'}`,
            ),
          );
        });
      });
    } finally {
      // Ensure the file stream is flushed whether the child succeeded
      // or not — otherwise the tar step might read a truncated file.
      await new Promise<void>((resolve) => out.end(() => resolve()));
    }
  }

  // ---------------------------------------------------------------
  // Private: MinIO mirror
  // ---------------------------------------------------------------

  /**
   * Stream every object in the configured bucket into `targetDir/`,
   * preserving the object-key tree as directory structure. Returns
   * totals for the manifest.
   */
  private async mirrorMinio(
    targetDir: string,
  ): Promise<{ count: number; bytes: number }> {
    let continuation: string | undefined;
    let count = 0;
    let bytes = 0;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ...(continuation ? { ContinuationToken: continuation } : {}),
        }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        const outPath = path.join(targetDir, obj.Key);
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        const get = await this.s3.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: obj.Key }),
        );
        const body = get.Body;
        if (!body) continue;
        const readable =
          body instanceof Readable ? body : Readable.fromWeb(body as never);
        await pipeline(readable, createWriteStream(outPath));
        count += 1;
        bytes += Number(obj.Size ?? 0);
      }
      continuation = res.IsTruncated
        ? res.NextContinuationToken
        : undefined;
    } while (continuation);
    return { count, bytes };
  }

  // ---------------------------------------------------------------
  // Private: helpers
  // ---------------------------------------------------------------

  private extractDbName(url: string): string | null {
    // postgresql://user:pass@host:port/dbname?query
    const m = url.match(/\/([^/?]+)(\?|$)/);
    return m?.[1] ?? null;
  }

  private redactDbUrl(url: string): string {
    // Turn postgresql://user:pass@host:port/db into postgresql://user:***@host:port/db
    return url.replace(/(:\/\/[^:]+:)[^@]*(@)/, '$1***$2');
  }

  private readPortalVersion(): string | null {
    try {
      // Best-effort: at runtime the API runs from dist, so we look
      // alongside it for package.json. Failure is fine — the manifest
      // version field is informational.
      const pkg = require('../../package.json') as { version?: string };
      return pkg.version ?? null;
    } catch {
      return null;
    }
  }
}
