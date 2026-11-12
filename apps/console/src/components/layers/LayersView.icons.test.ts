// REQ-PERF-001 REQ-UI-012 — the Layers screen imports its vendor marks one by one (the whole simple-icons catalogue was a
// 5 MB chunk every screen paid for); every icon slug LAYER_MARKS names must have its import, or the mark would silently
// fall back to nothing.
import { describe, expect, it } from 'vitest';
import { LAYER_MARKS } from '@/lib/layer-stack-model';
import { iconFor } from './LayersView';

describe('vendor marks', () => {
  it('has an imported icon for every icon slug the layer model names', () => {
    const slugs = Object.values(LAYER_MARKS)
      .flat()
      .flatMap((mark) => (mark.kind === 'icon' ? [mark.slug] : []));
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) expect(iconFor(slug)?.path, slug).toMatch(/^[Mm]/u);
  });

  it('knows no icon for a slug outside the model', () => {
    expect(iconFor('not-a-vendor')).toBeNull();
  });
});
