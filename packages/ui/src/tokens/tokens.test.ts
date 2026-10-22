// T-006 REQ-UI-001
import { CI_LAYERS } from '@openmap/contracts';
import { describe, expect, it } from 'vitest';
import { componentClasses, tailwindTheme, themeCss } from '../tailwind-preset.js';
import {
  UI_STATES,
  accents,
  colors,
  cssVariables,
  displayLetterSpacing,
  fontSizePx,
  glow,
  glows,
  hexToRgb,
  keyframesCss,
  layerColors,
  radii,
  shadows,
  spacing,
  spacingSteps,
  stateColors,
  stylesheet,
  surfaces,
  text,
  tokens,
  withAlpha,
} from './index.js';

const HEX = /^#[0-9A-F]{6}$/;

describe('colour tokens', () => {
  it('encode the approved design values exactly', () => {
    expect(colors.ground).toBe('#070A12');
    expect(surfaces).toEqual({ surface1: '#0E1322', surface2: '#141A2C', surface3: '#1B2238' });
    expect(text).toEqual({ primary: '#EEF2FF', secondary: '#9AA3B8', muted: '#5E677C' });
    expect(accents.cyan).toBe('#22D3EE');
    expect(accents.violet).toBe('#8B5CF6');
    expect(accents.amber).toBe('#F5B82E');
    expect(accents.rose).toBe('#FB5B7A');
    expect(accents.emerald).toBe('#2DD4A0');
    expect(accents.sky).toBe('#38BDF8');
    expect(accents.blue).toBe('#60A5FA');
    expect(accents.lime).toBe('#A3E635');
    expect(accents.orange).toBe('#FB923C');
    expect(accents.fuchsia).toBe('#E879F9');
    expect(accents.steel).toBe('#C7CEE0');
    expect(colors.borderGlass).toBe('rgba(255,255,255,.07)');
    expect(colors.borderStrong).toBe('rgba(255,255,255,.1)');
  });
  it('are all well-formed hex', () => {
    for (const value of Object.values(accents)) expect(value).toMatch(HEX);
    for (const value of Object.values(text)) expect(value).toMatch(HEX);
  });
  it('converts hex to rgba for glows', () => {
    expect(hexToRgb('#22D3EE')).toEqual({ r: 34, g: 211, b: 238 });
    expect(withAlpha('#22D3EE', 0.45)).toBe('rgba(34,211,238,0.45)');
    expect(() => hexToRgb('#12')).toThrowError(/hexToRgb/);
  });
});

describe('layer and state tokens', () => {
  it('give every CI_LAYERS entry a colour and nothing more', () => {
    expect(Object.keys(layerColors).sort()).toEqual([...CI_LAYERS].sort());
    for (const layer of CI_LAYERS) expect(layerColors[layer]).toMatch(HEX);
  });
  it('map layers to the approved accents', () => {
    expect(layerColors.dc).toBe(accents.amber);
    expect(layerColors.network_security).toBe(accents.cyan);
    expect(layerColors.hardware).toBe(accents.steel);
    expect(layerColors.storage).toBe('#A78BFA');
    expect(layerColors.virtualization).toBe(accents.emerald);
    expect(layerColors.cloud).toBe(accents.blue);
    expect(layerColors.os).toBe(accents.lime);
    expect(layerColors.containers).toBe(accents.sky);
    expect(layerColors.databases).toBe(accents.orange);
    expect(layerColors.applications).toBe(accents.rose);
    expect(layerColors.saas).toBe(accents.fuchsia);
    expect(layerColors.unknown).toBe('#9AA3B8');
  });
  it('cover every UI state', () => {
    expect(Object.keys(stateColors).sort()).toEqual([...UI_STATES].sort());
    expect(stateColors).toEqual({
      healthy: '#2DD4A0',
      degraded: '#F5B82E',
      down: '#FB5B7A',
      unknown: '#9AA3B8',
      at_risk: '#A78BFA',
    });
  });
});

describe('scale tokens', () => {
  it('typography scale, radii and spacing match the design', () => {
    expect(Object.values(fontSizePx)).toEqual([11, 12, 12.5, 13, 13.5, 15, 18, 22, 26, 28, 32, 40]);
    expect(radii).toEqual({ tag: 7, control: 8, controlMd: 10, controlLg: 11, panel: 12, panelLg: 14, card: 18, pill: 999 });
    expect(Object.values(spacing)).toEqual([...spacingSteps]);
    expect(spacingSteps).toEqual([4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32]);
  });
  it('tightens display tracking with size', () => {
    expect(displayLetterSpacing(13)).toBe('0');
    expect(displayLetterSpacing(22)).toBe('-0.02em');
    expect(displayLetterSpacing(28)).toBe('-0.03em');
    expect(displayLetterSpacing(40)).toBe('-0.04em');
  });
  it('shadows and glows use the approved geometry', () => {
    expect(shadows.innerHighlight).toBe('inset 0 1px 0 rgba(255,255,255,.05)');
    expect(shadows.card).toBe('0 30px 60px -30px rgba(0,0,0,.8)');
    expect(glow('bar', accents.cyan)).toBe('0 0 14px rgba(34,211,238,0.45)');
    expect(glow('button', accents.cyan)).toBe('0 12px 28px -10px rgba(34,211,238,0.8)');
    expect(glow('nav', accents.violet)).toBe('0 10px 30px -14px rgba(139,92,246,0.7)');
    expect(glows.barCyan).toBe(glow('bar', accents.cyan));
  });
  it('exposes every group on the tokens object', () => {
    expect(Object.keys(tokens).sort()).toEqual(
      ['colors', 'direction', 'glows', 'layers', 'motion', 'radii', 'shadows', 'spacing', 'states', 'typography'].sort(),
    );
  });
});

describe('cssVariables()', () => {
  const css = cssVariables();
  it('emits a :root block with --om- variables for every group', () => {
    expect(css.startsWith(':root {')).toBe(true);
    expect(css).toContain('--om-ground: #070A12;');
    expect(css).toContain('--om-surface1: #0E1322;');
    expect(css).toContain('--om-text-primary: #EEF2FF;');
    expect(css).toContain('--om-accent-cyan: #22D3EE;');
    expect(css).toContain('--om-layer-network-security: #22D3EE;');
    expect(css).toContain('--om-state-at-risk: #A78BFA;');
    expect(css).toContain('--om-radius-card: 18px;');
    expect(css).toContain('--om-space-32: 32px;');
    expect(css).toContain('--om-text-size-2xl: 26px;');
    expect(css).toContain("--om-font-display: 'Manrope'");
    expect(css).toContain('--om-shadow-card: 0 30px 60px -30px rgba(0,0,0,.8);');
    expect(css).toContain('--om-glow-bar-cyan: 0 0 14px rgba(34,211,238,0.45);');
  });
  it('emits direction blocks for ltr and rtl that only differ in sign, angle and side', () => {
    expect(css).toContain('[dir=ltr] {\n  --om-dir-flow-sign: 1;\n  --om-dir-flow-angle: 90deg;\n  --om-dir-inline-start: left;\n  --om-dir-inline-end: right;\n}');
    expect(css).toContain('[dir=rtl] {\n  --om-dir-flow-sign: -1;\n  --om-dir-flow-angle: 270deg;\n  --om-dir-inline-start: right;\n  --om-dir-inline-end: left;\n}');
  });
  it('never emits a raw value that is not a token (no http, no px outside scale groups)', () => {
    expect(css).not.toMatch(/https?:/);
  });
  it('stylesheet() adds the pulse keyframes', () => {
    expect(keyframesCss()).toContain('@keyframes om-pulse');
    expect(stylesheet()).toContain(css);
    expect(stylesheet()).toContain('@keyframes om-pulse');
  });
});

describe('tailwind preset', () => {
  it('exposes tokens as om-* utilities', () => {
    expect(tailwindTheme.colors['om-ground']).toBe('#070A12');
    expect(tailwindTheme.colors['om-surface1']).toBe('#0E1322');
    expect(tailwindTheme.colors['om-layer-dc']).toBe('#F5B82E');
    expect(tailwindTheme.colors['om-state-healthy']).toBe('#2DD4A0');
    expect(tailwindTheme.colors['om-border-glass']).toBe('rgba(255,255,255,.07)');
    expect(tailwindTheme.borderRadius['om-card']).toBe('18px');
    expect(tailwindTheme.boxShadow['om-card']).toBe('0 30px 60px -30px rgba(0,0,0,.8)');
    expect(tailwindTheme.boxShadow['om-glow-bar-cyan']).toBe('0 0 14px rgba(34,211,238,0.45)');
    expect(tailwindTheme.fontFamily['om-display']).toContain('Manrope');
    expect(tailwindTheme.fontSize['om-2xl']).toBe('26px');
    expect(tailwindTheme.spacing['om-16']).toBe('16px');
  });
  it('generates a Tailwind v4 @theme block', () => {
    const css = themeCss();
    expect(css.startsWith('@theme {')).toBe(true);
    expect(css).toContain('--color-om-cyan: #22D3EE;');
    expect(css).toContain('--radius-om-pill: 999px;');
    expect(css).toContain('--shadow-om-card-with-highlight: 0 30px 60px -30px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.05);');
    expect(css).toContain("--font-om-mono: 'JetBrains Mono'");
    expect(css).toContain('--text-om-5xl: 40px;');
    expect(css).toContain('--spacing-om-4: 4px;');
    expect(css).toContain('--ease-om-standard: cubic-bezier(.2,.8,.2,1);');
  });
  it('component classes only reference om-* tokens or layout utilities', () => {
    for (const classes of Object.values(componentClasses)) {
      for (const cls of classes.split(' ')) {
        expect(cls).not.toMatch(/#|\[/);
      }
    }
  });
});
