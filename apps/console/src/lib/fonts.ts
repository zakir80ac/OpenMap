// REQ-UI-003 REQ-UI-025 — typefaces: Chakra Petch (Horizon display face for headings and figures), Manrope (display
// fallback), Inter (body), JetBrains Mono (code) and IBM Plex Sans Arabic for the ar locale. Each exposes a CSS
// variable that globals.css maps onto the --om-font-* tokens.
import { Chakra_Petch, IBM_Plex_Sans_Arabic, Inter, JetBrains_Mono, Manrope } from 'next/font/google';

export const chakraPetch = Chakra_Petch({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-chakra', display: 'swap' });
export const manrope = Manrope({ subsets: ['latin'], variable: '--font-manrope', display: 'swap' });
export const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
export const jetbrainsMono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', display: 'swap' });
export const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-arabic',
  display: 'swap',
});

/** Class list for <html>: every variable is present in both locales so switching locale never reflows for fonts. */
export const fontClassNames = [chakraPetch.variable, manrope.variable, inter.variable, jetbrainsMono.variable, plexArabic.variable].join(' ');
