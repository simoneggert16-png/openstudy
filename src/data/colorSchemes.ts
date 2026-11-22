import { ColorSchemeId } from '../types';

export interface ColorSchemeDefinition {
  id: ColorSchemeId;
  name: string;
  tagline: string;
  isDark: boolean;
  themeColor: string;
  /** [canvas, primary, warmAccent] */
  swatches: [string, string, string];
}

export const COLOR_SCHEMES: ColorSchemeDefinition[] = [
  {
    id: 'focus-cream',
    name: 'Focus Cream',
    tagline: 'Warmes Papier, tiefes Petrol und ein Hauch Orange',
    isDark: false,
    themeColor: '#0E4D48',
    swatches: ['#F6F1E7', '#0E4D48', '#D96B27'],
  },
  {
    id: 'midnight-teal',
    name: 'Midnight Teal',
    tagline: 'Ruhiges Nachtpetrol mit warmem Bernstein-Akzent',
    isDark: true,
    themeColor: '#0E1817',
    swatches: ['#0E1817', '#3AB2A5', '#E98344'],
  },
  {
    id: 'terracotta-paper',
    name: 'Terracotta Paper',
    tagline: 'Leinenpapier, warmes Terrakotta und tiefes Waldgrün',
    isDark: false,
    themeColor: '#B84A27',
    swatches: ['#F8F1E8', '#B84A27', '#135852'],
  },
  {
    id: 'botanical-sage',
    name: 'Botanical Sage',
    tagline: 'Sanftes Haferpapier, Salbeigrün und warmes Ocker',
    isDark: false,
    themeColor: '#234B3E',
    swatches: ['#F1F2EA', '#234B3E', '#D1792E'],
  },
  {
    id: 'espresso-ember',
    name: 'Espresso Ember',
    tagline: 'Dunkle Röstung, warmes Kupfer und ruhiges Petrol',
    isDark: true,
    themeColor: '#161210',
    swatches: ['#161210', '#E07B3C', '#4AA89B'],
  },
];

export function getColorSchemeById(id: string | undefined): ColorSchemeDefinition {
  return COLOR_SCHEMES.find((s) => s.id === id) ?? COLOR_SCHEMES[0];
}
