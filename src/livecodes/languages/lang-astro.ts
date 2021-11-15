import { LanguageSpecs } from '../models';
import { parserPlugins } from './prettier';
import { getLanguageCustomSettings } from './utils';

const cdnBaselUrl = 'https://cdn.jsdelivr.net/npm/@hatemhosny/astro-internal@0.0.3/';
const compilerURL = cdnBaselUrl + 'compiler.min.js';
const internalURL = cdnBaselUrl + 'index.min.js';
const wasmURL = 'https://cdn.jsdelivr.net/npm/@astrojs/compiler@0.2.23/astro.wasm';

export const astro: LanguageSpecs = {
  name: 'astro',
  title: 'Astro',
  parser: {
    name: 'html',
    pluginUrls: [parserPlugins.html, parserPlugins.babel],
  },
  compiler: {
    url: compilerURL,
    factory: () => {
      const { transform, initialize, renderAstroToHTML } = (self as any).astroCompiler;
      const compilerReady = initialize({ wasmURL });
      return async (code, { config }) => {
        await compilerReady;

        // // nested astro component
        // const script = await transform(config.script.content, {
        //   ...getLanguageCustomSettings('astro', config),
        //   sourcefile: 'script.jsx',
        //   sourcemap: false,
        //   internalURL,
        //   // site: location.href,
        //   as: 'fragment',
        // });
        // const url = `data:application/javascript;base64,${btoa(script.code)}`;

        // // when renderers are enabled (react/preact/vue/svelte)
        // // https://github.com/snowpackjs/astro-repl/blob/741460dfcbe894473f8e66153926cc653d0fe8b9/src/%40astro/internal/index.ts#L196
        // const scriptCode = options.script || '';
        // const url = `data:application/javascript;base64,${btoa(scriptCode)}`;

        // code = code.replace('./script.jsx', url);

        const result = await transform(code, {
          sourcefile: 'file.astro',
          sourcemap: false,
          internalURL,
          // site: location.href,
          ...getLanguageCustomSettings('astro', config),
        });
        const output = await renderAstroToHTML(result.code);
        if (output.errors) {
          for (const err of output.errors) {
            // eslint-disable-next-line no-console
            console.warn(err);
          }
          return '';
        }
        return output;
      };
    },
  },
  extensions: ['astro'],
  editor: 'markup',
  editorLanguage: 'html',
};
