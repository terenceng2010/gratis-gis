// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  classifyAndRow,
  computeCounts,
  computeWarnings,
  type DryRunItem,
} from './dry-run.js';
import type { AgoItem } from './ago-types.js';

function sample(overrides: Partial<AgoItem>): AgoItem {
  return {
    id: 'sample',
    type: 'Web Map',
    title: 'Sample Item',
    owner: 'alice',
    access: 'private',
    ...overrides,
  };
}

describe('classifyAndRow', () => {
  it('marks supported types as willImport=true with the target type', () => {
    const row = classifyAndRow(sample({ type: 'Feature Service' }), 'F1');
    expect(row.willImport).toBe(true);
    expect(row.targetType).toBe('service');
    expect(row.reason).toBeUndefined();
    expect(row.folderTitle).toBe('F1');
  });

  it('marks unsupported types as willImport=false with reason', () => {
    const row = classifyAndRow(sample({ type: 'StoryMap' }), '(root)');
    expect(row.willImport).toBe(false);
    expect(row.reason).toMatch(/not yet supported/);
  });

  it('captures the service URL for service items', () => {
    const row = classifyAndRow(
      sample({
        type: 'Feature Service',
        url: 'https://server.example/arcgis/rest/services/X/FeatureServer',
      }),
      '(root)',
    );
    expect(row.serviceUrl).toBe(
      'https://server.example/arcgis/rest/services/X/FeatureServer',
    );
  });
});

describe('computeCounts', () => {
  it('rolls up importable + skipped + per-type counts', () => {
    const items: DryRunItem[] = [
      classifyAndRow(sample({ id: 'a', type: 'Web Map' }), '(root)'),
      classifyAndRow(sample({ id: 'b', type: 'Feature Service' }), '(root)'),
      classifyAndRow(sample({ id: 'c', type: 'Feature Service' }), '(root)'),
      classifyAndRow(sample({ id: 'd', type: 'StoryMap' }), '(root)'),
    ];
    const counts = computeCounts(items, 2);
    expect(counts.foldersTotal).toBe(2);
    expect(counts.itemsTotal).toBe(4);
    expect(counts.itemsToImport).toBe(3);
    expect(counts.itemsToSkip).toBe(1);
    expect(counts.byTargetType.service).toBe(2);
    expect(counts.byTargetType.map).toBe(1);
    expect(counts.byAgoType['Web Map']).toBe(1);
    expect(counts.byAgoType['Feature Service']).toBe(2);
    expect(counts.byAgoType['StoryMap']).toBe(1);
  });

  it('returns zeroes for an empty input', () => {
    const counts = computeCounts([], 0);
    expect(counts.itemsTotal).toBe(0);
    expect(counts.itemsToImport).toBe(0);
    expect(counts.itemsToSkip).toBe(0);
  });
});

describe('computeWarnings', () => {
  it('groups skips by reason so the report does not duplicate', () => {
    const items: DryRunItem[] = [
      classifyAndRow(sample({ id: 's1', type: 'StoryMap' }), '(root)'),
      classifyAndRow(sample({ id: 's2', type: 'StoryMap' }), '(root)'),
      classifyAndRow(sample({ id: 's3', type: 'StoryMap' }), '(root)'),
    ];
    const counts = computeCounts(items, 0);
    const warnings = computeWarnings(items, counts);
    const skip = warnings.find((w) => w.severity === 'warn');
    expect(skip).toBeDefined();
    expect(skip!.message).toMatch(/3 item\(s\) will be skipped/);
    expect(skip!.affectedItemIds).toEqual(['s1', 's2', 's3']);
  });

  it('emits a service-auth reminder when any service is imported', () => {
    const items: DryRunItem[] = [
      classifyAndRow(sample({ id: 's', type: 'Feature Service' }), '(root)'),
    ];
    const counts = computeCounts(items, 0);
    const warnings = computeWarnings(items, counts);
    expect(
      warnings.some((w) => w.severity === 'info' && /credentials/.test(w.message)),
    ).toBe(true);
  });

  it('emits an "empty user" warning when nothing was found', () => {
    const warnings = computeWarnings([], computeCounts([], 0));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.message).toMatch(/No items found/);
  });

  it('does not emit the service-auth reminder when there are no services', () => {
    const items: DryRunItem[] = [
      classifyAndRow(sample({ id: 'w', type: 'Web Map' }), '(root)'),
    ];
    const counts = computeCounts(items, 0);
    const warnings = computeWarnings(items, counts);
    expect(
      warnings.some((w) => /credentials/.test(w.message)),
    ).toBe(false);
  });
});
