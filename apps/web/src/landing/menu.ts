import type { Key } from '../i18n';
import {
  IconBook, IconCamera, IconDownload, IconHelp, IconInfo, IconLink, IconPlay, IconShield, IconShieldCheck, IconTag, IconUsers,
  type IconComponent,
} from '../ui';

/** Public repository: the evidence links of the trust section and the "Technical documentation" menu item point here. */
export const REPO_URL = 'https://github.com/menarzullayev/davrabox';
export const docUrl = (path: string): string => `${REPO_URL}/blob/main/${path}`;

export interface MenuLink {
  id: string;
  href: string;
  icon: IconComponent;
  title: Key;
  desc: Key;
  /** Leaves this site (opens in a new tab, says so to screen readers). */
  external?: boolean;
}

export interface MenuGroup {
  id: 'product' | 'resources';
  label: Key;
  items: MenuLink[];
}

// Absolute "/#..." anchors so that the same menu works on the landing page and on /help.
export const MENU: MenuGroup[] = [
  {
    id: 'product',
    label: 'lnMenuProduct',
    items: [
      { id: 'features', href: '/#capabilities', icon: IconCamera, title: 'lnMenuFeaturesT', desc: 'lnMenuFeaturesD' },
      { id: 'demo', href: '/#demo', icon: IconPlay, title: 'lnMenuDemoT', desc: 'lnMenuDemoD' },
      { id: 'security', href: '/#trust', icon: IconShieldCheck, title: 'lnMenuSecurityT', desc: 'lnMenuSecurityD' },
      { id: 'apps', href: '/#download', icon: IconDownload, title: 'lnMenuAppsT', desc: 'lnMenuAppsD' },
      { id: 'orgs', href: '/#organisations', icon: IconUsers, title: 'lnMenuOrgsT', desc: 'lnMenuOrgsD' },
      { id: 'join', href: '/#join', icon: IconLink, title: 'lnMenuJoinT', desc: 'lnMenuJoinD' },
    ],
  },
  {
    id: 'resources',
    label: 'lnMenuResources',
    items: [
      { id: 'help', href: '/help', icon: IconHelp, title: 'lnMenuHelpT', desc: 'lnMenuHelpD' },
      { id: 'faq', href: '/help#faq', icon: IconInfo, title: 'lnMenuFaqT', desc: 'lnMenuFaqD' },
      { id: 'docs', href: `${REPO_URL}/tree/main/docs`, icon: IconBook, title: 'lnMenuDocsT', desc: 'lnMenuDocsD', external: true },
      { id: 'privacy', href: '/privacy', icon: IconShield, title: 'lnMenuPrivacyT', desc: 'lnMenuPrivacyD' },
    ],
  },
];

export const PRICING_LINK: MenuLink = { id: 'pricing', href: '/#pricing', icon: IconTag, title: 'lnMenuPricing', desc: 'lnMenuPricingD' };
