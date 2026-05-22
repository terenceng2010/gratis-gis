// SPDX-License-Identifier: AGPL-3.0-or-later
import { AgoImportService } from './import.js';
import type { DryRunReport } from './dry-run.js';
import { classifyAndRow } from './dry-run.js';
import type { AgoItem } from './ago-types.js';

import type { AuthUser } from '../auth/auth-sync.service.js';
import type { ItemsService } from '../items/items.service.js';
import type { WebMapJsonImportService } from '../items/web-map-json-import.service.js';

const PORTAL_URL = 'https://www.arcgis.com/sharing/rest';
const USER: AuthUser = {
  id: 'user-1',
  username: 'tester',
  orgId: 'org-1',
  roles: ['admin'],
  email: null,
} as unknown as AuthUser;

function sample(overrides: Partial<AgoItem>): AgoItem {
  return {
    id: 'sample',
    type: 'Web Map',
    title: 'Sample',
    owner: 'tester',
    access: 'private',
    ...overrides,
  };
}

function reportFrom(items: AgoItem[]): DryRunReport {
  return {
    portal: { url: PORTAL_URL, username: 'tester' },
    generatedAt: new Date().toISOString(),
    counts: {
      foldersTotal: 0,
      itemsTotal: items.length,
      itemsToImport: items.length,
      itemsToSkip: 0,
      byTargetType: {},
      byAgoType: {},
    },
    folders: [],
    items: items.map((it) => classifyAndRow(it, '(root)')),
    warnings: [],
  };
}

function makeFakeItems(): ItemsService {
  let counter = 0;
  const created: Array<{ type: string; title: string; data: unknown }> = [];
  const fake = {
    create: jest.fn(async (_user: AuthUser, input: any) => {
      counter += 1;
      created.push({ type: input.type, title: input.title, data: input.data });
      return { id: `portal-item-${counter}` };
    }),
    __created: created,
  };
  return fake as unknown as ItemsService;
}

function makeFakeWebMapImport(): WebMapJsonImportService {
  return {
    import: jest.fn(async (_args: any) => ({
      itemId: 'portal-map-1',
      warnings: [] as string[],
    })),
  } as unknown as WebMapJsonImportService;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('AgoImportService.run', () => {
  it('imports services + web maps + files in dependency order', async () => {
    const items = [
      sample({ id: 'wm-1', type: 'Web Map', title: 'Map' }),
      sample({
        id: 'svc-1',
        type: 'Feature Service',
        title: 'Parcels',
        url: 'https://server/arcgis/rest/services/Parcels/FeatureServer',
      }),
      sample({ id: 'file-1', type: 'PDF', title: 'Spec.pdf' }),
    ];
    // Web Map data fetch goes through fetch().
    globalThis.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ version: '2.30', layers: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const fakeItems = makeFakeItems();
    const fakeWebMap = makeFakeWebMapImport();
    const importer = new AgoImportService(fakeItems, fakeWebMap);
    const report = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    expect(report.total).toBe(3);
    expect(report.created).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(0);

    // The order in results MUST reflect the dependency order
    // (service before map before file), regardless of input
    // order.
    const order = report.results.map((r) => r.agoId);
    expect(order).toEqual(['svc-1', 'wm-1', 'file-1']);

    // The WebMap converter saw the right item.
    expect(fakeWebMap.import).toHaveBeenCalledTimes(1);
    expect((fakeWebMap.import as jest.Mock).mock.calls[0][0].title).toBe('Map');

    // ItemsService created the service + file items with the
    // right payload.
    const created = (fakeItems as any).__created;
    expect(created).toHaveLength(2);
    const service = created.find((c: any) => c.type === 'service');
    expect(service.data.url).toMatch(/FeatureServer$/);
    expect(service.data.protocol).toBe('arcgis_features');
    expect(service.data.agoItemId).toBe('svc-1');
    const file = created.find((c: any) => c.type === 'file');
    expect(file.data.kind).toBe('link');
    expect(file.data.agoItemId).toBe('file-1');
  });

  it('records per-item failures without blocking the rest of the import', async () => {
    const items = [
      sample({
        id: 'svc-1',
        type: 'Feature Service',
        title: 'Will succeed',
        url: 'https://server/arcgis/rest/services/A/FeatureServer',
      }),
      sample({
        id: 'svc-2',
        type: 'Feature Service',
        title: 'Will fail',
        url: 'https://server/arcgis/rest/services/B/FeatureServer',
      }),
      sample({
        id: 'svc-3',
        type: 'Feature Service',
        title: 'Will also succeed',
        url: 'https://server/arcgis/rest/services/C/FeatureServer',
      }),
    ];
    const fakeItems = {
      create: jest.fn(async (_u: AuthUser, input: any) => {
        if (input.title === 'Will fail') {
          throw new Error('contrived ItemsService failure');
        }
        return { id: `portal-${input.title}` };
      }),
    } as unknown as ItemsService;
    const importer = new AgoImportService(fakeItems, makeFakeWebMapImport());
    const report = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    expect(report.created).toBe(2);
    expect(report.failed).toBe(1);
    const failed = report.results.find((r) => r.status === 'failed');
    expect(failed?.agoId).toBe('svc-2');
    expect(failed?.error).toContain('contrived');
  });

  it('skips items the dry-run marked as not importable but records them in the report', async () => {
    const items = [
      sample({ id: 'wm', type: 'Web Map', title: 'OK' }),
      sample({ id: 'dash', type: 'Dashboard', title: 'Skipped dashboard' }),
      sample({ id: 'app', type: 'Web Mapping Application', title: 'Skipped app' }),
      sample({ id: 'form', type: 'Form', title: 'Skipped form' }),
    ];
    globalThis.fetch = jest.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    // The dry-run report's `willImport` flag is what governs.
    // Construct a synthetic report matching what the dry-run
    // service would have produced.
    const report = reportFrom(items);
    // Mutate willImport to match the type-mapping classifier.
    for (const row of report.items) {
      if (
        row.agoType === 'Dashboard' ||
        row.agoType === 'Web Mapping Application' ||
        row.agoType === 'Form'
      ) {
        row.willImport = false;
        row.targetType = null;
        row.reason = 'Skipped by classifier';
      }
    }
    const importer = new AgoImportService(makeFakeItems(), makeFakeWebMapImport());
    const result = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report,
    });
    expect(result.created).toBe(1); // Just the Web Map
    expect(result.skipped).toBe(3);
    const skipped = result.results.filter((r) => r.status === 'skipped');
    expect(skipped.map((r) => r.agoId).sort()).toEqual([
      'app',
      'dash',
      'form',
    ]);
    for (const s of skipped) {
      expect(s.warnings).toContain('Skipped by classifier');
    }
  });

  it('captures WebMap converter warnings on the result', async () => {
    const items = [
      sample({ id: 'wm-1', type: 'Web Map', title: 'Mixed Map' }),
    ];
    globalThis.fetch = jest.fn(async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const fakeWebMap = {
      import: jest.fn(async () => ({
        itemId: 'portal-map-1',
        warnings: ['Unresolvable layer XYZ skipped'],
      })),
    } as unknown as WebMapJsonImportService;
    const importer = new AgoImportService(makeFakeItems(), fakeWebMap);
    const report = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    expect(report.created).toBe(1);
    expect(report.results[0]!.warnings).toContain(
      'Unresolvable layer XYZ skipped',
    );
  });

  it('emits a per-item failure when the WebMap /data fetch errors', async () => {
    const items = [sample({ id: 'wm-1', type: 'Web Map', title: 'Map' })];
    globalThis.fetch = jest.fn(async () =>
      new Response('boom', { status: 500 }),
    );
    const importer = new AgoImportService(
      makeFakeItems(),
      makeFakeWebMapImport(),
    );
    const report = await importer.run({
      user: USER,
      portalUrl: PORTAL_URL,
      token: 'tok',
      report: reportFrom(items),
    });
    expect(report.failed).toBe(1);
    expect(report.results[0]!.error).toMatch(/Fetching WebMap JSON failed/);
  });
});
