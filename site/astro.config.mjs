// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// BASE_PATH is the path the site is served under (GitHub Pages: /<repo>/).
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://pimlock.github.io',
  base: process.env.BASE_PATH ?? '/',
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'OpenShell',
      description: 'The safe, private runtime for autonomous AI agents.',
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/pimlock/openshell-docs' }],
      customCss: ['./src/styles/tokens.css', './src/styles/theme.css'],
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' } },
        { tag: 'link', attrs: { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap' } },
      ],
      components: {
        Header: './src/components/overrides/Header.astro',
        Sidebar: './src/components/overrides/Sidebar.astro',
        PageTitle: './src/components/overrides/PageTitle.astro',
      },
      expressiveCode: {
        themes: ['github-dark-default', 'github-light'],
        styleOverrides: {
          borderRadius: 'var(--os-radius)',
          borderColor: 'var(--os-border)',
          codeFontFamily: 'var(--os-font-mono)',
          uiFontFamily: 'var(--os-font-sans)',
          codeFontSize: '0.8125rem',
          codeBackground: 'var(--os-surface)',
          frames: { shadowColor: 'transparent', editorTabBarBackground: 'var(--os-surface)', terminalTitlebarBackground: 'var(--os-surface)', terminalTitlebarBorderBottomColor: 'var(--os-border)', terminalBackground: 'var(--os-surface)', terminalTitlebarDotsOpacity: '0.35' },
        },
      },
      // Sidebar, pagination, topic tabs and the version picker all follow the
      // version context of the current page; see src/versioning.ts.
      routeMiddleware: './src/routeData.ts',
    }),
  ],
});
