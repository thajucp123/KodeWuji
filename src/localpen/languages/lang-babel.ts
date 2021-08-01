import { LanguageSpecs } from '../models';
import { parserPlugins } from './parser-plugins';
import { getLanguageCustomSettings } from './utils';

export const babel: LanguageSpecs = {
  name: 'babel',
  title: 'Babel',
  info: `
  <h3>Babel</h3>
  <div>The JavaScript compiler</div>
  <ul>
    <li><a href="https://babeljs.io/" target="_blank" rel="noopener">Official website</a></li>
    <li><a href="https://babeljs.io/docs/en/" target="_blank" rel="noopener">Babel documentation</a></li>
    <!-- <li><a href="#">Babel usage in LocalPen</a></li> -->
  </ul>
  `,
  parser: {
    name: 'babel',
    pluginUrls: [parserPlugins.babel, parserPlugins.html],
  },
  compiler: {
    url: 'vendor/babel/babel.min.js',
    factory: () => async (code, { config }) =>
      (window as any).Babel.transform(code, {
        filename: 'script.tsx',
        presets: [['env', { modules: false }], 'typescript', 'react'],
        ...getLanguageCustomSettings('babel', config),
      }).code,
    umd: true,
  },
  extensions: ['es', 'babel'],
  editor: 'script',
  editorLanguage: 'javascript',
};
