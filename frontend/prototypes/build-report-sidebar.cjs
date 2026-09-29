// Regenerate the standalone HTML navigation from the app's shared component.
// Run: node frontend/prototypes/build-report-sidebar.cjs
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const postcss = require('postcss');
const tailwind = require('tailwindcss');

async function build() {
  const source = path.resolve(__dirname, '../app/components/sidebar-nav.tsx');
  const result = await esbuild.build({ entryPoints: [source], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] });
  const compiled = new Module(__filename, module);
  compiled.paths = module.paths;
  compiled._compile(result.outputFiles[0].text, __filename);
  const items = [['prefill', 'prefill-1k-128'], ['balanced', 'balanced-2k-1k'], ['long', 'long-context-8k'], ['sharegpt', 'sharegpt']].map(([id, label], i) => ({ href: '#workload-' + id, label, icon: String(i + 1).padStart(2, '0'), active: false }));
  const markup = renderToStaticMarkup(React.createElement(compiled.exports.SidebarNav, { sections: [{ label: 'Workload', items }] }));
  const css = await postcss([tailwind({ content: [{ raw: fs.readFileSync(source, 'utf8'), extension: 'tsx' }], corePlugins: { preflight: false } })]).process('@tailwind utilities;', { from: undefined });
  const file = path.join(__dirname, 'deployment-report.html');
  const html = fs.readFileSync(file, 'utf8').replace(/<!-- SIDEBAR_START -->[\s\S]*?<!-- SIDEBAR_END -->/, '<!-- SIDEBAR_START -->' + markup + '<!-- SIDEBAR_END -->').replace(/\/\* SIDEBAR_CSS_START \*\/[\s\S]*?\/\* SIDEBAR_CSS_END \*\//, '/* SIDEBAR_CSS_START */\n' + css.css + '\n/* SIDEBAR_CSS_END */');
  fs.writeFileSync(file, html);
  console.log('Shared SidebarNav rendered into standalone report.');
}
build().catch(error => { console.error(error); process.exitCode = 1; });
