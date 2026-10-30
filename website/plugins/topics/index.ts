import type {LoadContext, Plugin} from '@docusaurus/types';

/**
 * Topic list for the search dialog's empty state: the sidebar categories and pages of the
 * current docs version, resolved to titles and permalinks at build time.
 */
export interface Topic {
  label: string;
  href: string;
  /** Sidebar categories above this page. */
  trail: string[];
}

interface SidebarItem {
  type: 'doc' | 'ref' | 'category' | 'link' | 'html';
  id?: string;
  label?: string;
  href?: string;
  items?: SidebarItem[];
  link?: {type: 'doc'; id: string} | {type: 'generated-index'; permalink: string} | undefined;
}
interface LoadedVersion {
  docs: Array<{id: string; title: string; permalink: string; frontMatter?: {sidebar_label?: string}}>;
  sidebars: Record<string, SidebarItem[]>;
}

export default function topicsPlugin(_context: LoadContext): Plugin {
  return {
    name: 'plp-topics',
    async allContentLoaded({allContent, actions}) {
      const docs = (allContent['docusaurus-plugin-content-docs'] as {default?: {loadedVersions: LoadedVersion[]}} | undefined)
        ?.default;
      const version = docs?.loadedVersions?.[0];
      const topics: Topic[] = [];
      if (version) {
        const byId = new Map(version.docs.map((d) => [d.id, d]));
        const walk = (items: SidebarItem[], trail: string[]) => {
          for (const item of items) {
            if (item.type === 'doc' || item.type === 'ref') {
              const doc = byId.get(item.id ?? '');
              if (doc) {
                topics.push({label: item.label ?? doc.frontMatter?.sidebar_label ?? doc.title, href: doc.permalink, trail});
              }
            } else if (item.type === 'link' && item.href) {
              topics.push({label: item.label ?? item.href, href: item.href, trail});
            } else if (item.type === 'category') {
              walk(item.items ?? [], [...trail, item.label ?? '']);
            }
          }
        };
        walk(version.sidebars.docs ?? [], []);
      }
      actions.setGlobalData({topics});
    },
  };
}
