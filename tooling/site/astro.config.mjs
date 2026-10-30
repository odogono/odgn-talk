// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import northtalk from '../vscode/syntaxes/northtalk.tmLanguage.json' with { type: 'json' };

// Cloudflare Web Analytics is cookieless. CI sets the beacon's token; local
// builds leave it out.
const analytics = process.env.CF_WEB_ANALYTICS_TOKEN;

export default defineConfig({
  site: 'https://northtalk.org',
  integrations: [
    starlight({
      title: 'NorthTalk',
      logo: { src: './public/favicon.svg' },
      customCss: ['./src/styles/theme.css'],
      head: analytics
        ? [
            {
              tag: 'script',
              attrs: {
                defer: true,
                src: 'https://static.cloudflareinsights.com/beacon.min.js',
                'data-cf-beacon': JSON.stringify({ token: analytics }),
              },
            },
          ]
        : [],
      description:
        'A HyperTalk-descended scripting language for untrusted end-user Scripts.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/odogono/odgn-talk' },
      ],
      expressiveCode: {
        shiki: {
          langs: [{ ...northtalk, name: 'talk', aliases: ['northtalk'] }],
        },
      },
      sidebar: [
        { label: 'Learn', items: ['learn/tour', 'learn/concepts'] },
        {
          label: 'Embed',
          items: [
            'embed/typescript-app',
            'embed/typescript',
            'embed/go',
            'embed/elixir',
            'embed/zig',
          ],
        },
        {
          label: 'Reference',
          items: [
            {
              label: 'Specification',
              items: [
                'reference/spec',
                { autogenerate: { directory: 'generated/reference/spec' } },
              ],
            },
            'reference/glossary',
            {
              label: 'Design decisions',
              link: 'https://github.com/odogono/odgn-talk/tree/main/docs/adr',
              attrs: { target: '_blank' },
            },
          ],
        },
        { label: 'Folio', link: '/folio/' },
        'examples',
      ],
    }),
  ],
});
