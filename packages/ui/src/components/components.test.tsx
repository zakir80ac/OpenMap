// T-007 REQ-UI-001
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectionProvider, directionForLocale, documentDirection, type Direction } from '../direction.js';
import { accents, layerColors, stateColors, withAlpha } from '../tokens/index.js';
import { Bar, Card, Donut, Dot, GlassPanel, Kpi, LayerBadge, Pill, SectionTitle, Segmented, Sparkline, StateBadge, Tag, donutArcs, kpiTone, sparklinePoints } from './index.js';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('dir');
});

function renderIn(dir: Direction, ui: ReactNode) {
  return render(<DirectionProvider dir={dir}>{ui}</DirectionProvider>);
}

const DIRS: readonly Direction[] = ['ltr', 'rtl'];

describe('DirectionProvider', () => {
  it('derives direction from locale through the shared constants', () => {
    expect(directionForLocale('ar')).toBe('rtl');
    expect(directionForLocale('en')).toBe('ltr');
  });
  it('falls back to document.dir when no provider is mounted', () => {
    expect(documentDirection()).toBe('ltr');
    document.documentElement.setAttribute('dir', 'rtl');
    expect(documentDirection()).toBe('rtl');
    render(<Card>body</Card>);
    expect(screen.getByText('body').closest('.om-card')?.getAttribute('dir')).toBe('rtl');
  });
});

describe.each(DIRS)('components render in %s', (dir) => {
  it('Card sets dir and uses token classes', () => {
    renderIn(dir, <Card padding="24">content</Card>);
    const card = screen.getByText('content');
    expect(card.getAttribute('dir')).toBe(dir);
    expect(card.className).toContain('bg-om-surface1');
    expect(card.className).toContain('rounded-om-card');
    expect(card.style.padding).toBe('var(--om-space-24)');
  });
  it('GlassPanel renders an accent edge only when asked', () => {
    const { container, rerender } = renderIn(dir, <GlassPanel>panel</GlassPanel>);
    expect(container.querySelector('[data-part="accent-edge"]')).toBeNull();
    rerender(
      <DirectionProvider dir={dir}>
        <GlassPanel accent={accents.violet} as="aside">
          panel
        </GlassPanel>
      </DirectionProvider>,
    );
    const panel = screen.getByText('panel');
    expect(panel.tagName).toBe('ASIDE');
    expect(panel.getAttribute('dir')).toBe(dir);
    expect(container.querySelector('[data-part="accent-edge"]')).not.toBeNull();
    expect(panel.style.getPropertyValue('--om-panel-accent')).toBe(withAlpha(accents.violet, 0.55));
  });
  it('Pill variants map to the right accent and element', () => {
    const onClick = vi.fn();
    renderIn(
      dir,
      <>
        <Pill>plain</Pill>
        <Pill variant="primary">primary</Pill>
        <Pill variant="violet">violet</Pill>
        <Pill variant="time-travel">tt</Pill>
        <Pill variant="primary" selected onClick={onClick}>
          action
        </Pill>
      </>,
    );
    const plain = screen.getByText('plain').closest('.om-pill');
    const primary = screen.getByText('primary').closest('.om-pill');
    const violet = screen.getByText('violet').closest('.om-pill');
    const tt = screen.getByText('tt').closest('.om-pill');
    expect(plain?.getAttribute('data-variant')).toBe('default');
    expect(primary?.getAttribute('data-variant')).toBe('primary');
    expect((primary as HTMLElement).style.getPropertyValue('--om-pill-accent')).toBe(accents.cyan);
    expect((violet as HTMLElement).style.getPropertyValue('--om-pill-accent')).toBe(accents.violet);
    expect((tt as HTMLElement).style.borderStyle).toBe('dashed');
    expect((plain as HTMLElement).style.boxShadow).toBe('');
    // Formal profile (REQ-UI-034): accent pills carry no glow unless asked.
    expect((primary as HTMLElement).style.boxShadow).toBe('');
    const button = screen.getByRole('button', { pressed: true });
    expect(button.getAttribute('dir')).toBe(dir);
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
  it('Tag variants pick state and layer accents', () => {
    renderIn(
      dir,
      <>
        <Tag>neutral</Tag>
        <Tag variant="state" state="degraded">
          deg
        </Tag>
        <Tag variant="layer" layer="databases">
          db
        </Tag>
      </>,
    );
    const neutral = screen.getByText('neutral').closest('.om-tag') as HTMLElement;
    const deg = screen.getByText('deg').closest('.om-tag') as HTMLElement;
    const db = screen.getByText('db').closest('.om-tag') as HTMLElement;
    expect(neutral.getAttribute('data-variant')).toBe('neutral');
    expect(deg.getAttribute('data-state')).toBe('degraded');
    expect(deg.style.getPropertyValue('--om-tag-accent')).toBe(stateColors.degraded);
    expect(db.getAttribute('data-layer')).toBe('databases');
    expect(db.style.getPropertyValue('--om-tag-accent')).toBe(layerColors.databases);
    expect(db.getAttribute('dir')).toBe(dir);
  });
  it('Dot is decorative unless labelled, and pulses on request', () => {
    const { container } = renderIn(
      dir,
      <>
        <Dot state="healthy" />
        <Dot state="down" pulse label="down" />
      </>,
    );
    const dots = container.querySelectorAll<HTMLElement>('.om-dot');
    expect(dots).toHaveLength(2);
    expect(dots[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(dots[0]?.style.getPropertyValue('--om-dot-accent')).toBe(stateColors.healthy);
    expect(dots[0]?.style.boxShadow).toContain('0 0 14px');
    expect(screen.getByRole('img', { name: 'down' }).getAttribute('data-pulse')).toBe('true');
    expect(dots[1]?.style.animation).toContain('om-pulse');
  });
  it('Kpi shows label, value, unit and a toned delta', () => {
    renderIn(dir, <Kpi label="latency" value="42" unit="ms" delta={-3} lowerIsBetter />);
    const root = screen.getByText('latency').closest('.om-kpi') as HTMLElement;
    expect(root.getAttribute('dir')).toBe(dir);
    expect(screen.getByText('42')).toBeDefined();
    expect(screen.getByText('ms')).toBeDefined();
    const delta = root.querySelector<HTMLElement>('[data-part="delta"]');
    expect(delta?.getAttribute('data-tone')).toBe('positive');
    expect(delta?.textContent).toContain('-3');
  });
  it('LayerBadge and StateBadge compose Tag with a swatch or Dot', () => {
    const { container } = renderIn(
      dir,
      <>
        <LayerBadge layer="cloud" label="cloud" />
        <StateBadge state="healthy" label="ok" live />
      </>,
    );
    const layer = screen.getByText('cloud').closest('.om-tag') as HTMLElement;
    expect(layer.getAttribute('data-layer')).toBe('cloud');
    expect(container.querySelector('[data-part="swatch"]')).not.toBeNull();
    const state = screen.getByText('ok').closest('.om-tag') as HTMLElement;
    expect(state.getAttribute('data-state')).toBe('healthy');
    expect(state.querySelector('.om-dot')?.getAttribute('data-pulse')).toBe('true');
  });
  it('SectionTitle renders heading level, eyebrow, description and action', () => {
    renderIn(
      dir,
      <SectionTitle as="h3" size="lg" eyebrow="eye" description="desc" action={<Pill>act</Pill>}>
        title
      </SectionTitle>,
    );
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.textContent).toBe('title');
    expect(heading.style.fontSize).toBe('22px');
    expect(heading.style.letterSpacing).toBe('-0.02em');
    expect(screen.getByText('eye')).toBeDefined();
    expect(screen.getByText('desc')).toBeDefined();
    const action = screen.getByText('act').closest('[data-part="action"]') as HTMLElement;
    expect(action.style.marginInlineStart).toBe('auto');
    expect(heading.closest('.om-section-title')?.getAttribute('dir')).toBe(dir);
  });
});

describe('Bar', () => {
  it('clamps the value and exposes progressbar semantics', () => {
    renderIn('ltr', <Bar value={150} max={100} label="cpu" />);
    const bar = screen.getByRole('progressbar', { name: 'cpu' });
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
    const fill = bar.querySelector<HTMLElement>('[data-part="fill"]');
    expect(fill?.style.width).toBe('100%');
  });
  it('fills from the inline start and flips its gradient and origin in rtl', () => {
    const { unmount } = renderIn('ltr', <Bar value={25} />);
    const ltr = screen.getByRole('progressbar');
    const ltrFill = ltr.querySelector<HTMLElement>('[data-part="fill"]');
    expect(ltr.getAttribute('data-dir')).toBe('ltr');
    expect(ltr.style.getPropertyValue('--om-flow-angle')).toBe('90deg');
    expect(ltrFill?.getAttribute('data-origin')).toBe('left');
    expect(ltrFill?.style.width).toBe('25%');
    unmount();

    renderIn('rtl', <Bar value={25} accent={accents.violet} />);
    const rtl = screen.getByRole('progressbar');
    const rtlFill = rtl.querySelector<HTMLElement>('[data-part="fill"]');
    expect(rtl.getAttribute('dir')).toBe('rtl');
    expect(rtl.getAttribute('data-dir')).toBe('rtl');
    expect(rtl.style.getPropertyValue('--om-flow-angle')).toBe('270deg');
    expect(rtlFill?.getAttribute('data-origin')).toBe('right');
    expect(rtl.style.getPropertyValue('--om-bar-accent')).toBe(accents.violet);
    // Formal profile (REQ-UI-034): the fill glows only on request.
    expect(rtlFill?.style.boxShadow).toBe('');
  });
  it('omits the glow when disabled', () => {
    renderIn('ltr', <Bar value={10} glowing={false} />);
    const fill = screen.getByRole('progressbar').querySelector<HTMLElement>('[data-part="fill"]');
    expect(fill?.style.boxShadow).toBe('');
  });
});

describe('kpiTone', () => {
  it('treats drops as good when lower is better', () => {
    expect(kpiTone(5)).toBe('positive');
    expect(kpiTone(-5)).toBe('negative');
    expect(kpiTone(-5, true)).toBe('positive');
    expect(kpiTone(0)).toBe('neutral');
  });
});

// REQ-UI-032 — chart primitives behind the dashboard widgets.
describe('Sparkline', () => {
  it('maps a series onto the view box, newest at the inline end, and mirrors in rtl', () => {
    const points = sparklinePoints([1, 3, 2], 100, 36);
    expect(points.length).toBe(3);
    expect(points[0]?.[0]).toBeLessThan(points[2]?.[0] ?? 0);
    expect(points[1]?.[1]).toBeLessThan(points[0]?.[1] ?? 0);
    for (const dir of DIRS) {
      renderIn(dir, <Sparkline values={[1, 3, 2]} label="cis" />);
      const svg = screen.getByRole('img', { name: 'cis' });
      expect(svg.getAttribute('data-points')).toBe('3');
      expect(svg.querySelector('polyline')).not.toBeNull();
      expect(svg.querySelector('polyline')?.getAttribute('transform') !== null).toBe(dir === 'rtl');
      cleanup();
    }
  });
  it('renders a single point as a dot without a line', () => {
    renderIn('ltr', <Sparkline values={[5]} label="one" />);
    const svg = screen.getByRole('img', { name: 'one' });
    expect(svg.querySelector('polyline')).toBeNull();
    expect(svg.querySelector('circle')).not.toBeNull();
  });
});

describe('Donut', () => {
  it('shares the ring proportionally and names each segment', () => {
    const arcs = donutArcs([
      { value: 1, accent: accents.cyan, label: 'a' },
      { value: 3, accent: accents.rose, label: 'b' },
    ]);
    expect(arcs[0]).toEqual({ start: 0, end: 0.25 });
    expect(arcs[1]?.end).toBe(1);
    renderIn('ltr', <Donut segments={[{ value: 2, accent: accents.cyan, label: 'healthy' }, { value: 0, accent: accents.rose, label: 'down' }]} centre="2" caption="services" label="health" />);
    const svg = screen.getByRole('img', { name: 'health' });
    expect(svg.querySelector('[data-segment="healthy"]')).not.toBeNull();
    expect(svg.querySelector('[data-segment="down"]')).toBeNull();
    expect(screen.getByText('2')).toBeTruthy();
  });
});

describe('Segmented', () => {
  it('is a radiogroup whose selected option is checked and which reports changes', () => {
    const onChange = vi.fn();
    renderIn('rtl', <Segmented label="range" value="a" onChange={onChange} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />);
    const group = screen.getByRole('radiogroup', { name: 'range' });
    expect(group.getAttribute('dir')).toBe('rtl');
    expect(screen.getByRole('radio', { name: 'A' }).getAttribute('aria-checked')).toBe('true');
    screen.getByRole('radio', { name: 'B' }).click();
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
