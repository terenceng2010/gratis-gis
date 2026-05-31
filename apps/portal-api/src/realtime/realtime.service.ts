// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { SharingService } from '../items/sharing.service.js';
import type { AuthUser } from '../auth/auth-sync.service.js';

/**
 * #156 Realtime presence + live cursors, Phase 1.
 *
 * Phase 1 ships HTTP polling (not WebSockets) so the feature
 * lands without infra changes: the existing BFF allowlist
 * already lets a signed-in client GET / POST to portal-api, and
 * Caddy doesn't need a new route. A presence client polls
 * heartbeat every 2 seconds; the server keeps an in-memory
 * per-map roster with a 5-second TTL on missing heartbeats.
 *
 * Phase 1.5 swaps this for a Nest WebSocket gateway behind a
 * Caddy WS route once we want sub-second cursor latency. The
 * client-facing shape (members[] with cursor / color /
 * displayName) is the same, so the swap is a transport change
 * only.
 *
 * In-memory only: with two portal-api replicas behind a load
 * balancer, presence works within a single replica's heartbeats.
 * Acceptable for the small-team buyer; Redis cross-replica
 * fanout lands when the user count justifies it.
 */
const HEARTBEAT_TTL_MS = 5_000;

/** Active member of a presence room. */
export interface PresenceMember {
  /** Stable per-tab id; minted server-side on first heartbeat
   *  for a user/connection that didn't carry one. */
  connectionId: string;
  userId: string;
  displayName: string;
  color: string;
  /** Last cursor in WGS84. Null until the client sends one. */
  cursor: { lng: number; lat: number } | null;
  /** ms-since-epoch. Server scrubs entries older than HEARTBEAT_TTL_MS. */
  lastSeenAt: number;
}

interface RoomState {
  members: Map<string, PresenceMember>; // keyed by connectionId
}

const PALETTE: string[] = [
  '#0ea5e9', // sky
  '#f97316', // orange
  '#22c55e', // green
  '#a855f7', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#eab308', // amber
  '#3b82f6', // blue
];

@Injectable()
export class RealtimeService {
  private readonly rooms = new Map<string, RoomState>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sharing: SharingService,
  ) {}

  /**
   * Apply a heartbeat from a viewer. Returns the active member
   * list (post-prune) so the client gets fresh state on every
   * heartbeat round-trip without needing a separate GET.
   */
  async heartbeat(
    user: AuthUser,
    mapId: string,
    input: {
      connectionId?: string;
      cursor?: { lng: number; lat: number } | null;
    },
  ): Promise<{ me: PresenceMember; members: PresenceMember[] }> {
    await this.assertCanRead(user, mapId);
    const room = this.getOrCreate(mapId);
    this.prune(room);
    const connectionId =
      typeof input.connectionId === 'string' && input.connectionId.length > 0
        ? input.connectionId.slice(0, 80)
        : mintConnectionId(user.id);
    let cursor: { lng: number; lat: number } | null = null;
    if (input.cursor && typeof input.cursor === 'object') {
      const lng = Number((input.cursor as { lng?: unknown }).lng);
      const lat = Number((input.cursor as { lat?: unknown }).lat);
      if (
        Number.isFinite(lng) &&
        Number.isFinite(lat) &&
        lng >= -180 &&
        lng <= 180 &&
        lat >= -90 &&
        lat <= 90
      ) {
        cursor = { lng, lat };
      }
    }
    const existing = room.members.get(connectionId);
    let member: PresenceMember;
    if (existing) {
      existing.cursor = cursor;
      existing.lastSeenAt = Date.now();
      member = existing;
    } else {
      const displayName = await this.resolveDisplay(user);
      const color = this.nextColor(room);
      member = {
        connectionId,
        userId: user.id,
        displayName,
        color,
        cursor,
        lastSeenAt: Date.now(),
      };
      room.members.set(connectionId, member);
    }
    return {
      me: member,
      members: Array.from(room.members.values()),
    };
  }

  /**
   * Drop the viewer's presence row. Called on page unload via
   * navigator.sendBeacon so the avatar disappears immediately
   * instead of waiting out the heartbeat TTL.
   */
  async leave(
    user: AuthUser,
    mapId: string,
    connectionId: string,
  ): Promise<void> {
    await this.assertCanRead(user, mapId);
    const room = this.rooms.get(mapId);
    if (!room) return;
    const existing = room.members.get(connectionId);
    if (existing && existing.userId !== user.id) return; // can only drop your own
    room.members.delete(connectionId);
    if (room.members.size === 0) this.rooms.delete(mapId);
  }

  /**
   * Pure read endpoint for clients that just want the roster
   * without sending a heartbeat (e.g. an admin viewing live
   * presence stats). Most callers should use heartbeat() so the
   * round-trip both refreshes their own presence and pulls down
   * the latest roster in one shot.
   */
  async list(user: AuthUser, mapId: string): Promise<PresenceMember[]> {
    await this.assertCanRead(user, mapId);
    const room = this.rooms.get(mapId);
    if (!room) return [];
    this.prune(room);
    return Array.from(room.members.values());
  }

  // ---- helpers ----------------------------------------------------------

  private getOrCreate(mapId: string): RoomState {
    let room = this.rooms.get(mapId);
    if (!room) {
      room = { members: new Map() };
      this.rooms.set(mapId, room);
    }
    return room;
  }

  private prune(room: RoomState): void {
    const cutoff = Date.now() - HEARTBEAT_TTL_MS;
    for (const [id, m] of room.members) {
      if (m.lastSeenAt < cutoff) room.members.delete(id);
    }
  }

  private nextColor(room: RoomState): string {
    const used = new Set(
      Array.from(room.members.values()).map((m) => m.color.toLowerCase()),
    );
    for (const c of PALETTE) {
      if (!used.has(c.toLowerCase())) return c;
    }
    return PALETTE[room.members.size % PALETTE.length]!;
  }

  private async resolveDisplay(user: AuthUser): Promise<string> {
    const row = await this.prisma.user
      .findUnique({
        where: { id: user.id },
        select: { fullName: true, username: true },
      })
      .catch(() => null);
    const name =
      (row?.fullName && row.fullName.trim().length > 0
        ? row.fullName
        : null) ??
      row?.username ??
      user.username ??
      'Viewer';
    return name.slice(0, 80);
  }

  private async assertCanRead(user: AuthUser, mapId: string): Promise<void> {
    const item = await this.prisma.item.findFirst({
      where: { id: mapId, type: 'map', deletedAt: null },
    });
    if (!item) throw new NotFoundException('Map not found');
    const shares = await this.prisma.itemShare.findMany({
      where: { itemId: mapId },
    });
    if (!this.sharing.canRead(user, item, shares)) {
      throw new ForbiddenException('You do not have access to this map');
    }
  }
}

function mintConnectionId(userId: string): string {
  return `${userId}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}
