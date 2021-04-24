import Split from 'split.js';

import { createEditor } from './editor';
import {
  languages,
  getLanguageByAlias,
  getLanguageEditorId,
  getLanguageCompiler,
  createLanguageMenus,
  languageIsEnabled,
} from './languages';
import { createStorage } from './storage';
import {
  CodeEditor,
  CssPresetId,
  EditorId,
  EditorLanguages,
  EditorOptions,
  Editors,
  Language,
  Pen,
  ToolList,
} from './models';
import { getFormatter } from './formatter';
import { createNotifications } from './notifications';
import { createModal } from './modal';
import {
  resultTemplate,
  importScreen,
  resourcesScreen,
  savePromptScreen,
  templatesScreen,
  openScreen,
} from './html';
import { exportPen } from './export';
import { createEventsManager } from './events';
import { getStarterTemplates } from './templates';
import { defaultConfig } from './config';
import { createToolsPane } from './tools';
import { createConsole } from './console';
import { createCompiledCodeViewer } from './compiled-code-viewer';
import { importCode } from './import';
import { compress, debounce } from './utils';
import { getCompiler } from './compiler';
import { loadTypes } from './load-types';
import { createResultPage } from './result';

export const app = async (config: Pen) => {
  // get a fresh immatuable copy of config
  const getConfig = (): Pen => JSON.parse(JSON.stringify(config));

  const setConfig = (newConfig: Pen) => {
    config = JSON.parse(JSON.stringify(newConfig));
  };
  const elements = {
    markup: '#markup',
    style: '#style',
    script: '#script',
    result: '#result',
  };

  const { baseUrl } = getConfig();
  const storage = createStorage();
  const templates = createStorage('__localpen_templates__');
  const formatter = getFormatter(getConfig());
  let editors: Editors;
  let penId: string;
  let editorLanguages: EditorLanguages;
  let activeEditorId: EditorId;
  const notifications = createNotifications();
  const modal = createModal();
  const eventsManager = createEventsManager();
  let isSaved = true;
  let changingContent = false;
  let toolsPane: any;
  let lastCompiled: { [key in EditorId]: string };
  let consoleInputCodeCompletion: any;

  const createSplitPanes = () => {
    const gutterSize = 10;
    const split = Split(['#editors', '#output'], {
      minSize: [0, 0],
      gutterSize,
      elementStyle: (_dimension, size, gutterSize) => {
        window.dispatchEvent(new Event('editor-resize'));
        return {
          'flex-basis': `calc(${size}% - ${gutterSize}px)`,
        };
      },
      gutterStyle: (_dimension, gutterSize) => ({
        'flex-basis': `${gutterSize}px`,
      }),
      onDragStart() {
        setAnimation(false);
      },
      onDragEnd() {
        setAnimation(true);
      },
    });

    const gutter = document.querySelector('.gutter');
    if (gutter) {
      const handle = document.createElement('div');
      handle.id = 'handle';
      gutter.appendChild(handle);
    }
    return split;
  };
  const split = createSplitPanes();

  const setAnimation = (animate: boolean) => {
    const editorsElement: HTMLElement | null = document.querySelector('#editors');
    const outputElement: HTMLElement | null = document.querySelector('#output');
    if (!outputElement || !editorsElement) return;

    if (animate) {
      editorsElement.style.transition = 'flex-basis 0.5s';
      outputElement.style.transition = 'flex-basis 0.5s';
    } else {
      editorsElement.style.transition = 'none';
      outputElement.style.transition = 'none';
    }
  };

  const showPane = (pane: 'code' | 'output') => {
    if (!split) return;
    const smallScreen = window.innerWidth < 800;
    const codeOpen = smallScreen ? [100, 0] : [50, 50];
    const outputOpen = smallScreen ? [0, 100] : [50, 50];
    if (pane === 'code' && split.getSizes()[0] < 10) {
      split.setSizes(codeOpen);
    } else if (pane === 'output' && split.getSizes()[1] < 10) {
      split.setSizes(outputOpen);
    }
  };

  function createIframe(container: string, result?: string) {
    return new Promise((resolve) => {
      const containerEl = document.querySelector(container);
      if (!containerEl) return;

      const iframe = document.createElement('iframe');
      iframe.setAttribute('allow', 'camera; geolocation; microphone');
      iframe.setAttribute('allowfullscreen', 'true');
      iframe.setAttribute('allowtransparency', 'true');
      iframe.setAttribute(
        'sandbox',
        'allow-downloads allow-forms allow-modals allow-orientation-lock allow-pointer-lock allow-popups allow-presentation allow-scripts',
      );

      const { mode } = getConfig();
      if (mode !== 'codeblock' && mode !== 'editor') {
        iframe.src = baseUrl + 'assets/result.html';
      }

      let loaded = false;
      eventsManager.addEventListener(iframe, 'load', () => {
        if (!result || loaded) {
          resolve('loaded');
          return; // prevent infinite loop
        }

        iframe.contentWindow?.postMessage({ result }, '*');
        loaded = true;
        resolve('loaded');
      });

      containerEl.innerHTML = '';
      containerEl.appendChild(iframe);
    });
  }

  const compiler = getCompiler(getConfig());

  const loadModules = async (config: Pen) => {
    if (editors.script && typeof editors.script.addTypes === 'function') {
      const libs = await loadTypes(config.modules);
      libs.forEach((lib) => editors.script.addTypes?.(lib));
    }
  };

  const getEditorLanguage = (editorId: EditorId) => editorLanguages[editorId];
  const getEditorLanguages = () => Object.values(editorLanguages);

  const setEditorTitle = (editorId: EditorId, title: string) => {
    const editorTitle = document.querySelector(`#${editorId}-selector span`);
    if (!editorTitle) return;
    editorTitle.innerHTML = languages.find((language) => language.name === title)?.title || '';
  };

  const copyToClipboard = (text: string) => {
    if (document.queryCommandSupported && document.queryCommandSupported('copy')) {
      const textarea = document.createElement('textarea');
      textarea.textContent = text;
      textarea.style.position = 'fixed'; // Prevent scrolling to bottom of page in Microsoft Edge.
      document.body.appendChild(textarea);
      textarea.select();
      try {
        return document.execCommand('copy'); // Security exception may be thrown by some browsers.
      } catch (ex) {
        // eslint-disable-next-line no-console
        console.warn('Copy to clipboard failed.', ex);
        return false;
      } finally {
        document.body.removeChild(textarea);
      }
    }
    return false;
  };

  const createCopyButtons = (editors: Editors) => {
    const editorIds: EditorId[] = ['markup', 'style', 'script'];
    editorIds.forEach((editorId) => {
      const copyButton = document.createElement('button');
      copyButton.innerHTML = 'copy';
      copyButton.classList.add('copy-button');
      document.getElementById(editorId)?.appendChild(copyButton);
      eventsManager.addEventListener(copyButton, 'click', () => {
        if (copyToClipboard(editors[editorId].getValue())) {
          copyButton.innerHTML = 'copied';
          setTimeout(() => {
            copyButton.innerHTML = 'copy';
          }, 2000);
        }
      });
    });
  };

  const createEditors = async (config: Pen) => {
    const baseOptions = {
      baseUrl: config.baseUrl,
      mode: config.mode,
      readonly: config.readonly,
      editor: config.editor,
      editorType: 'code' as EditorOptions['editorType'],
    };
    const markupOptions: EditorOptions = {
      ...baseOptions,
      container: document.querySelector(elements.markup),
      language: languageIsEnabled(config.markup.language, config)
        ? config.markup.language
        : config.languages?.find((lang) => getLanguageEditorId(lang) === 'markup') || 'html',
      value: languageIsEnabled(config.markup.language, config) ? config.markup.content || '' : '',
    };
    const styleOptions: EditorOptions = {
      ...baseOptions,
      container: document.querySelector(elements.style),
      language: languageIsEnabled(config.style.language, config)
        ? config.style.language
        : config.languages?.find((lang) => getLanguageEditorId(lang) === 'style') || 'css',
      value: languageIsEnabled(config.style.language, config) ? config.style.content || '' : '',
    };
    const scriptOptions: EditorOptions = {
      ...baseOptions,
      container: document.querySelector(elements.script),
      language: languageIsEnabled(config.script.language, config)
        ? config.script.language
        : config.languages?.find((lang) => getLanguageEditorId(lang) === 'script') || 'javascript',
      value: languageIsEnabled(config.script.language, config) ? config.script.content || '' : '',
    };
    const markupEditor = await createEditor(markupOptions);
    const styleEditor = await createEditor(styleOptions);
    const scriptEditor = await createEditor(scriptOptions);

    setEditorTitle('markup', markupOptions.language);
    setEditorTitle('style', styleOptions.language);
    setEditorTitle('script', scriptOptions.language);

    editorLanguages = {
      markup: markupOptions.language,
      style: styleOptions.language,
      script: scriptOptions.language,
    };

    const editors = {
      markup: markupEditor,
      style: styleEditor,
      script: scriptEditor,
    };

    (Object.keys(editors) as EditorId[]).forEach(async (editorId) => {
      editors[editorId].registerFormatter(await formatter.getFormatFn(editorLanguages[editorId]));
      registerRun(editorId, editors);
    });

    if (config.mode === 'codeblock') {
      createCopyButtons(editors);
    }

    return editors;
  };

  const updateEditors = async (editors: Editors, config: Pen) => {
    const language = config.language;
    const editorIds = Object.keys(editors) as Array<keyof Editors>;
    for (const editorId of editorIds) {
      editors[editorId].setValue(config[editorId].content);
      await changeLanguage(editorId, config[editorId].language, true);
    }
    setConfig({
      ...getConfig(),
      language,
    });
  };

  const showMode = (config: Pen) => {
    const modes = {
      full: '111',
      editor: '110',
      codeblock: '010',
      result: '001',
    };
    const modeConfig = modes[config.mode] || '111';

    const toolbarElement = document.querySelector('#toolbar') as HTMLElement;
    const editorContainerElement = document.querySelector('#editor-container') as HTMLElement;
    const editorsElement = document.querySelector('#editors') as HTMLElement;
    const outputElement = document.querySelector('#output') as HTMLElement;
    const resultElement = document.querySelector('#result') as HTMLElement;
    const gutterElement = document.querySelector('.gutter') as HTMLElement;
    const runButton = document.querySelector('#run-button') as HTMLElement;
    const codeRunButton = document.querySelector('#code-run-button') as HTMLElement;

    const showToolbar = modeConfig[0] === '1';
    const showEditor = modeConfig[1] === '1';
    const showResult = modeConfig[2] === '1';

    toolbarElement.style.display = 'flex';
    editorsElement.style.display = 'flex';
    resultElement.style.display = 'flex';
    outputElement.style.display = 'block';
    gutterElement.style.display = 'block';
    gutterElement.style.display = 'block';
    runButton.style.visibility = 'visible';
    codeRunButton.style.visibility = 'visible';

    if (!showToolbar) {
      toolbarElement.style.display = 'none';
      editorContainerElement.style.height = '100%';
    }
    if (!showEditor) {
      outputElement.style.flexBasis = '100%';
      editorsElement.style.display = 'none';
      split.destroy(true);
    }
    if (!showResult) {
      editorsElement.style.flexBasis = '100%';
      outputElement.style.display = 'none';
      resultElement.style.display = 'none';
      codeRunButton.style.display = 'none';
      split.destroy(true);
    }
    if (config.mode === 'editor' || config.mode === 'codeblock') {
      runButton.style.visibility = 'hidden';
      codeRunButton.style.visibility = 'hidden';
    }
    window.dispatchEvent(new Event('editor-resize'));
  };

  const showEditor = (editorId: EditorId = 'markup') => {
    const editorDivs = document.querySelectorAll('#editors > div') as NodeListOf<HTMLElement>;
    editorDivs.forEach((editor) => (editor.style.display = 'none'));
    const activeEditor = document.getElementById(editorId) as HTMLElement;
    activeEditor.style.display = 'block';

    const titles = document.querySelectorAll('.editor-title');
    titles.forEach((selector) => selector.classList.remove('active'));
    const activeTitle = document.getElementById(editorId + '-selector') as HTMLElement;
    activeTitle.classList.add('active');
    editors[editorId].focus();

    activeEditorId = editorId;
    setConfig({
      ...getConfig(),
      language: getEditorLanguage(editorId),
    });

    updateCompiledCode();
    showPane('code');
  };

  const addConsoleInputCodeCompletion = () => {
    if (consoleInputCodeCompletion) {
      consoleInputCodeCompletion.dispose();
    }
    if (editorLanguages.script === 'javascript') {
      if (editors.script && typeof editors.script.addTypes === 'function') {
        consoleInputCodeCompletion = editors.script.addTypes({
          content: editors.script.getValue(),
          filename: 'script.js',
        });
      }
    }
  };

  const phpHelper = ({ editor, code }: { editor?: CodeEditor; code?: string }) => {
    const addToken = (code: string) => (code.trim().startsWith('<?php') ? code : '<?php\n' + code);
    if (code) {
      return addToken(code);
    }
    if (editor?.getLanguage() === 'php') {
      editor.setValue(addToken(editor.getValue()));
    }
    return;
  };

  const changeLanguage = async (editorId: EditorId, language: Language, reload = false) => {
    if (!editorId || !language || !languageIsEnabled(language, getConfig())) return;
    const editor = editors[editorId];
    editor.setLanguage(language);
    editorLanguages[editorId] = language;
    setEditorTitle(editorId, language);
    showEditor(editorId);
    phpHelper({ editor: editors.script });
    editor.focus();
    await compiler.load([language], getConfig());
    editor.registerFormatter(await formatter.getFormatFn(language));
    if (!reload) {
      await run(editors);
    }
    setConfig({
      ...getConfig(),
      language,
    });
    addConsoleInputCodeCompletion();
  };

  // Ctrl/Cmd + Enter triggers run
  const registerRun = (editorId: EditorId, editors: Editors) => {
    const editor = editors[editorId];
    editor.addKeyBinding('run', editor.keyCodes.CtrlEnter, async () => {
      await run(editors);
    });
  };

  const updateCompiledCode = () => {
    const scriptType = getLanguageCompiler(editors.script.getLanguage())?.scriptType;
    const compiledLanguages: { [key in EditorId]: Language } = {
      markup: getEditorLanguage('markup') === 'mdx' ? 'javascript' : 'html',
      style: 'css',
      script: scriptType ? editors.script.getLanguage() : 'javascript',
    };
    if (toolsPane && toolsPane.compiled && lastCompiled) {
      Object.keys(lastCompiled).forEach((editorId) => {
        if (editorId !== activeEditorId) return;
        let compiledCode = lastCompiled[editorId];
        if (editorId === 'script' && editors.script.getLanguage() === 'php') {
          compiledCode = phpHelper({ code: compiledCode }) || '<?php\n';
        }
        toolsPane.compiled.update(compiledLanguages[editorId], compiledCode, getConfig());
      });
    }
  };

  const getResultPage = async (
    editors: Editors,
    forExport = false,
    template: string = resultTemplate,
  ) => {
    const getCompiled = (content: string, language: Language) =>
      compiler.compile(content, language, config);

    const compiledCode = {
      markup: {
        language: getEditorLanguage('markup'),
        content: await getCompiled(editors.markup?.getValue(), getEditorLanguage('markup')),
      },
      style: {
        language: getEditorLanguage('style'),
        content: await getCompiled(editors.style?.getValue(), getEditorLanguage('style')),
      },
      script: {
        language: getEditorLanguage('script'),
        content: await getCompiled(editors.script?.getValue(), getEditorLanguage('script')),
      },
    };

    // cache compiled code
    lastCompiled = {
      markup: compiledCode.markup.content,
      style: compiledCode.style.content,
      script: compiledCode.script.content,
    };

    return createResultPage(compiledCode, getConfig(), forExport, template);
  };

  const setLoading = (status: boolean) => {
    const loading = document.querySelector('#tools-pane-loading') as HTMLElement;
    if (!loading) return;
    if (status === true) {
      loading.style.display = 'unset';
    } else {
      loading.style.display = 'none';
    }
  };

  const setWindowTitle = () => {
    const title = getConfig().title;
    parent.document.title = (title ? title + ' - ' : '') + 'LocalPen';
  };

  const run = async (editors: Editors) => {
    setLoading(true);
    const result = await getResultPage(editors);
    await createIframe(elements.result, result);
    updateCompiledCode();
  };

  const save = (notify = false) => {
    if (!penId) {
      penId = storage.addItem(getConfig());
    } else {
      storage.updateItem(penId, getConfig());
    }
    if (notify) {
      notifications.success('Project saved');
    }
    setSavedStatus(true);
  };

  const fork = () => {
    penId = '';
    loadConfig({ ...getConfig(), title: getConfig().title + ' (fork)' });
    save();
    notifications.success('Forked as a new project');
  };

  const share = () => {
    const config = getConfig();
    const content: Partial<Pen> = {
      title: config.title,
      language: config.language,
      markup: config.markup,
      style: config.style,
      script: config.script,
      stylesheets: config.stylesheets,
      scripts: config.scripts,
      cssPreset: config.cssPreset,
      modules: config.modules,
    };

    const contentHash = '#code/' + compress(JSON.stringify(content));
    const shareURL = location.origin + location.pathname + contentHash;

    parent.history.pushState(null, '', shareURL);
    copyToClipboard(shareURL);
    notifications.info('URL copied to clipboard');
  };

  const update = () => {
    const editorIds: EditorId[] = ['markup', 'style', 'script'];
    editorIds.forEach((editorId) => {
      setConfig({
        ...getConfig(),
        [editorId]: {
          ...getConfig()[editorId],
          language: getEditorLanguage(editorId),
          content: editors[editorId].getValue(),
        },
      });
    });
  };

  const loadConfig = async (newConfig: Pen, url?: string) => {
    changingContent = true;

    const content: Partial<Pen> = {
      title: newConfig.title,
      language: newConfig.language,
      markup: newConfig.markup,
      style: newConfig.style,
      script: newConfig.script,
      stylesheets: newConfig.stylesheets,
      scripts: newConfig.scripts,
      cssPreset: newConfig.cssPreset,
      modules: newConfig.modules || getConfig().modules,
    };
    setConfig({ ...getConfig(), ...content, autosave: false });

    // load title
    const projectTitle = document.querySelector('#project-title') as HTMLElement;
    projectTitle.textContent = getConfig().title;
    setWindowTitle();

    // reset url params
    parent.history.pushState(null, '', url || location.origin + location.pathname);

    // load config
    await bootstrap(true);

    changingContent = false;
  };

  const setSavedStatus = (status: boolean) => {
    isSaved = status;

    const projectTitle = document.querySelector('#project-title') as HTMLElement;

    if (!isSaved) {
      projectTitle.classList.add('unsaved');
    } else {
      projectTitle.classList.remove('unsaved');
    }
  };

  const checkSavedStatus = (doNotCloseModal = false) => {
    if (isSaved) {
      return Promise.resolve('is saved');
    }
    return new Promise((resolve, reject) => {
      const div = document.createElement('div');
      div.innerHTML = savePromptScreen;
      modal.show(div.firstChild as HTMLElement, 'small');
      eventsManager.addEventListener(
        document.querySelector('#modal #prompt-save-btn') as HTMLElement,
        'click',
        () => {
          save(true);
          if (!doNotCloseModal) {
            modal.close();
          }
          resolve('save');
        },
      );
      eventsManager.addEventListener(
        document.querySelector('#modal #prompt-donot-save-btn') as HTMLElement,
        'click',
        () => {
          if (!doNotCloseModal) {
            modal.close();
          }
          resolve('do not save');
        },
      );
      eventsManager.addEventListener(
        document.querySelector('#modal #prompt-cancel-btn') as HTMLElement,
        'click',
        () => {
          modal.close();
          reject('cancel');
        },
      );
    });
  };

  const checkSavedAndExecute = (fn: () => void) => async () => {
    try {
      await checkSavedStatus(true);
      fn();
    } catch (error) {
      // cancelled
    }
  };

  const configureEmmet = (config: Pen) => {
    let emmetSupported;
    Object.values(editors).forEach((editor: CodeEditor) => {
      if (editor.configureEmmet && typeof editor.configureEmmet === 'function') {
        emmetSupported = true;
        editor.configureEmmet(config.emmet);
      }
    });
    if (!emmetSupported) {
      const emmetSetting = document.querySelector('#settings-menu #emmet')?.closest('li');
      if (emmetSetting) {
        emmetSetting.style.display = 'none';
      }
    }
  };

  const attachEventListeners = (editors: Editors) => {
    const handleTitleEdit = () => {
      const projectTitle = document.querySelector('#project-title') as HTMLElement;
      projectTitle.textContent = getConfig().title;

      setWindowTitle();

      eventsManager.addEventListener(
        projectTitle,
        'input',
        () => {
          const title = projectTitle.textContent || '';
          setSavedStatus(false);
          setConfig({ ...getConfig(), title });
          if (getConfig().autosave) {
            save();
          }
          setWindowTitle();
        },
        false,
      );
      eventsManager.addEventListener(
        projectTitle,
        'keypress',
        (e) => {
          setSavedStatus(false);
          if ((e as KeyboardEvent).which === 13) {
            (e as KeyboardEvent).preventDefault();
            projectTitle.blur();
          }
        },
        false,
      );
    };

    const handleResize = () => {
      const resizeEditors = () => {
        Object.values(editors).forEach((editor: CodeEditor) => {
          setTimeout(() => {
            if (editor.layout) {
              editor.layout(); // resize monaco editor
            }
          });
        });
      };
      resizeEditors();
      eventsManager.addEventListener(window, 'resize', resizeEditors, false);
      eventsManager.addEventListener(window, 'editor-resize', resizeEditors, false);
    };

    const handleIframeResize = () => {
      const gutter = document.querySelector('#editor-container .gutter') as HTMLElement;
      const sizeLabel = document.createElement('div');
      sizeLabel.id = 'size-label';
      gutter.appendChild(sizeLabel);

      const hideLabel = debounce(() => {
        setTimeout(() => {
          sizeLabel.classList.remove('visible');
        }, 1000);
      }, 1000);

      eventsManager.addEventListener(window, 'message', (event: any) => {
        const iframe = document.querySelector(elements.result + ' > iframe') as HTMLIFrameElement;
        if (
          !sizeLabel ||
          !iframe ||
          event.source !== iframe.contentWindow ||
          event.data.type !== 'resize'
        ) {
          return;
        }

        const sizes = event.data.sizes;
        sizeLabel.innerHTML = `${sizes.width} x ${sizes.height}`;
        sizeLabel.classList.add('visible');
        hideLabel();
      });
    };

    const handleSelectEditor = () => {
      (document.querySelectorAll('.editor-title') as NodeListOf<HTMLElement>).forEach((title) => {
        eventsManager.addEventListener(
          title,
          'click',
          () => {
            showEditor(title.dataset.editor as EditorId);
          },
          false,
        );
      });
    };

    const handlechangeLanguage = () => {
      if (getConfig().allowLangChange) {
        (document.querySelectorAll('#select-editor a') as NodeListOf<HTMLElement>).forEach(
          (menuItem) => {
            eventsManager.addEventListener(
              menuItem,
              'mousedown', // fire this event before unhover
              async () => {
                await changeLanguage(
                  menuItem.dataset.editor as EditorId,
                  menuItem.dataset.lang as Language,
                );
              },
              false,
            );
          },
        );
      } else {
        (document.querySelectorAll('#select-editor button') as NodeListOf<HTMLElement>).forEach(
          (menuButton) => {
            menuButton.style.display = 'none';
          },
        );
      }
    };

    const handleChangeContent = () => {
      const contentChanged = async (loading: boolean) => {
        update();
        setSavedStatus(false);
        addConsoleInputCodeCompletion();

        if (getConfig().autoupdate && !loading) {
          await run(editors);
        }

        if (getConfig().autosave) {
          save();
        }
      };

      const debouncecontentChanged = debounce(async () => {
        await contentChanged(changingContent);
      }, getConfig().delay ?? 500);

      editors.markup.onContentChanged(debouncecontentChanged);
      editors.style.onContentChanged(debouncecontentChanged);
      editors.script.onContentChanged(debouncecontentChanged);
    };

    const handleHotKeys = () => {
      const ctrl = (e: KeyboardEvent) => (navigator.platform.match('Mac') ? e.metaKey : e.ctrlKey);
      const hotKeys = async (e: KeyboardEvent) => {
        if (!e) return;

        // Cmd + Shift + S forks the project (save as...)
        if (ctrl(e) && e.shiftKey && e.keyCode === 83) {
          e.preventDefault();
          fork();
          return;
        }

        // Cmd + S saves the project
        if (ctrl(e) && e.keyCode === 83) {
          e.preventDefault();
          save(true);
          return;
        }

        // Cmd + p opens the command palette
        const activeEditor = editors[activeEditorId];
        if (ctrl(e) && e.keyCode === 80 && activeEditor.monaco) {
          e.preventDefault();
          activeEditor.monaco.trigger('anyString', 'editor.action.quickCommand');
          return;
        }

        // Cmd + d prevents browser bookmark dialog
        if (ctrl(e) && e.keyCode === 68) {
          e.preventDefault();
          return;
        }
      };

      eventsManager.addEventListener(window, 'keydown', hotKeys as any, true);
    };

    const handleRunButton = () => {
      const handleRun = async () => {
        showPane('output');
        await run(editors);
      };
      eventsManager.addEventListener(
        document.querySelector('#run-button') as HTMLElement,
        'click',
        handleRun,
      );
      eventsManager.addEventListener(
        document.querySelector('#code-run-button') as HTMLElement,
        'click',
        handleRun,
      );
    };

    const handleSettings = () => {
      const toggles = document.querySelectorAll(
        '#settings-menu input',
      ) as NodeListOf<HTMLInputElement>;
      toggles.forEach((toggle) => {
        eventsManager.addEventListener(toggle, 'change', async () => {
          const configKey = toggle.dataset.config;
          if (!configKey || !(configKey in getConfig())) return;

          setConfig({ ...getConfig(), [configKey]: toggle.checked });

          if (configKey === 'autoupdate' && getConfig()[configKey]) {
            await run(editors);
          }
          if (configKey === 'emmet') {
            configureEmmet(getConfig());
          }
          if (configKey === 'autoprefixer') {
            await run(editors);
          }
        });
      });

      const cssPresets = document.querySelectorAll(
        '#css-preset-menu a',
      ) as NodeListOf<HTMLAnchorElement>;
      cssPresets.forEach((link) => {
        eventsManager.addEventListener(
          link,
          'click',
          async (event: Event) => {
            event.preventDefault();
            setConfig({
              ...getConfig(),
              cssPreset: link.dataset.preset as CssPresetId,
            });
            cssPresets.forEach((preset) => {
              preset.classList.remove('active');
            });
            link.classList.add('active');
            await run(editors);
          },
          false,
        );
      });
    };

    const handleNew = () => {
      const createTemplatesUI = () => {
        const div = document.createElement('div');
        div.innerHTML = templatesScreen;
        const templatesContainer = div.firstChild as HTMLElement;
        const noDataMessage = templatesContainer.querySelector('.no-data');

        const tabs = templatesContainer.querySelectorAll(
          '#templates-tabs li',
        ) as NodeListOf<HTMLElement>;
        tabs.forEach((tab) => {
          eventsManager.addEventListener(tab, 'click', () => {
            tabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');

            (document.querySelectorAll(
              '#templates-screens > div',
            ) as NodeListOf<HTMLElement>).forEach((screen) => {
              screen.classList.remove('active');
            });
            const target = templatesContainer.querySelector(
              '#' + tab.dataset.target,
            ) as HTMLElement;
            target.classList.add('active');
            target.querySelector('input')?.focus();
          });
        });

        const starterTemplatesList = templatesContainer.querySelector(
          '#starter-templates-list',
        ) as HTMLElement;
        getStarterTemplates(getConfig()).forEach((template) => {
          const li = document.createElement('li') as HTMLElement;
          const link = document.createElement('a') as HTMLAnchorElement;
          link.href = '#';
          link.innerHTML = `
          <img src="${baseUrl + template.thumbnail}" />
          <div>${template.title}</div>
          `;
          eventsManager.addEventListener(
            link,
            'click',
            () => {
              const { title, thumbnail, ...templateConfig } = template;
              penId = '';
              loadConfig({
                ...defaultConfig,
                ...templateConfig,
              });
              modal.close();
            },
            false,
          );
          li.appendChild(link);
          starterTemplatesList.appendChild(li);
        });

        const userTemplatesScreen = templatesContainer.querySelector(
          '#templates-user .modal-screen',
        ) as HTMLElement;
        const userTemplates = templates.getList();

        if (userTemplates.length > 0) {
          userTemplatesScreen.innerHTML = '';
        }
        const list = document.createElement('ul') as HTMLElement;
        list.classList.add('open-list');
        userTemplatesScreen.appendChild(list);

        userTemplates.forEach((item) => {
          const li = document.createElement('li');
          list.appendChild(li);

          const link = document.createElement('a');
          link.href = '#';
          link.dataset.id = item.id;
          link.classList.add('open-project-link');
          link.innerHTML = `
            <div class="open-title">${item.title}</div>
            <div class="modified-date"><span>Last modified: </span>${new Date(
              item.lastModified,
            ).toLocaleString()}</div>
          `;
          li.appendChild(link);
          eventsManager.addEventListener(
            link,
            'click',
            async (event) => {
              event.preventDefault();
              const itemId = (link as HTMLElement).dataset.id || '';
              const template = templates.getItem(itemId)?.pen;
              if (template) {
                await loadConfig({
                  ...template,
                  title: defaultConfig.title,
                });
                penId = '';
              }
              modal.close();
            },
            false,
          );

          const deleteButton = document.createElement('button');
          deleteButton.classList.add('delete-button');
          li.appendChild(deleteButton);
          eventsManager.addEventListener(
            deleteButton,
            'click',
            () => {
              templates.deleteItem(item.id);
              li.classList.add('hidden');
              setTimeout(() => {
                li.style.display = 'none';
                if (templates.getList().length === 0 && noDataMessage) {
                  list.remove();
                  userTemplatesScreen.appendChild(noDataMessage);
                }
              }, 500);
            },
            false,
          );
        });

        modal.show(templatesContainer);
      };
      eventsManager.addEventListener(
        document.querySelector('#new-link') as HTMLElement,
        'click',
        checkSavedAndExecute(createTemplatesUI),
        false,
      );
    };

    const handleSave = () => {
      eventsManager.addEventListener(
        document.querySelector('#save-link') as HTMLElement,
        'click',
        (event) => {
          (event as Event).preventDefault();
          save(true);
        },
      );
    };

    const handleFork = () => {
      eventsManager.addEventListener(
        document.querySelector('#fork-link') as HTMLElement,
        'click',
        (event) => {
          (event as Event).preventDefault();
          fork();
        },
      );
    };

    const handleSaveAsTemplate = () => {
      eventsManager.addEventListener(
        document.querySelector('#template-link') as HTMLElement,
        'click',
        (event) => {
          (event as Event).preventDefault();
          templates.addItem(getConfig());
          notifications.success('Saved as a new template');
        },
      );
    };

    const handleOpen = () => {
      const createList = () => {
        const div = document.createElement('div');
        div.innerHTML = openScreen;
        const listContainer = div.firstChild as HTMLElement;
        const noDataMessage = listContainer.querySelector('.no-data');
        const list = document.createElement('ul') as HTMLElement;
        list.classList.add('open-list');

        const deleteAllButton = listContainer.querySelector('#delete-all-button') as HTMLElement;
        eventsManager.addEventListener(
          deleteAllButton,
          'click',
          () => {
            storage.clear();
            penId = '';
            if (list) list.remove();
            if (noDataMessage) listContainer.appendChild(noDataMessage);
            deleteAllButton.classList.add('hidden');
          },
          false,
        );

        listContainer.appendChild(list);
        const userPens = storage.getList();

        userPens.forEach((item) => {
          const li = document.createElement('li');
          list.appendChild(li);

          const link = document.createElement('a');
          link.href = '#';
          link.dataset.id = item.id;
          link.classList.add('open-project-link');
          link.innerHTML = `
            <div class="open-title">${item.title}</div>
            <div class="modified-date"><span>Last modified: </span>${new Date(
              item.lastModified,
            ).toLocaleString()}</div>
          `;
          li.appendChild(link);

          eventsManager.addEventListener(
            link,
            'click',
            async (event) => {
              event.preventDefault();

              const loading = document.createElement('div');
              loading.innerHTML = 'Loading...<br /><br />' + item.title + '';
              loading.className = 'centered';
              modal.show(loading, 'small');

              const itemId = (link as HTMLElement).dataset.id || '';
              const savedPen = storage.getItem(itemId)?.pen;
              if (savedPen) {
                await loadConfig(savedPen);
                penId = itemId;
              }
              modal.close();
              loading.remove();
            },
            false,
          );

          const deleteButton = document.createElement('button');
          deleteButton.classList.add('delete-button');
          li.appendChild(deleteButton);
          eventsManager.addEventListener(
            deleteButton,
            'click',
            () => {
              if (item.id === penId) {
                penId = '';
              }
              storage.deleteItem(item.id);
              li.classList.add('hidden');
              setTimeout(() => {
                li.style.display = 'none';
                if (storage.getList().length === 0 && noDataMessage) {
                  list.remove();
                  listContainer.appendChild(noDataMessage);
                  deleteAllButton.classList.add('hidden');
                }
              }, 500);
            },
            false,
          );
        });

        if (userPens.length === 0) {
          list.remove();
          deleteAllButton.remove();
        } else {
          noDataMessage?.remove();
        }

        modal.show(listContainer);
      };

      eventsManager.addEventListener(
        document.querySelector('#open-link') as HTMLElement,
        'click',
        checkSavedAndExecute(createList),
        false,
      );
    };

    const handleImport = () => {
      const createImportUI = () => {
        const div = document.createElement('div');
        div.innerHTML = importScreen;
        const importContainer = div.firstChild as HTMLElement;

        const tabs = importContainer.querySelectorAll('#import-tabs li') as NodeListOf<HTMLElement>;
        tabs.forEach((tab) => {
          eventsManager.addEventListener(tab, 'click', () => {
            tabs.forEach((t) => t.classList.remove('active'));
            tab.classList.add('active');

            (document.querySelectorAll('#import-screens > div') as NodeListOf<HTMLElement>).forEach(
              (screen) => {
                screen.classList.remove('active');
              },
            );
            const target = importContainer.querySelector('#' + tab.dataset.target) as HTMLElement;
            target.classList.add('active');
            target.querySelector('input')?.focus();
          });
        });

        const importForm = importContainer.querySelector('#url-import-form') as HTMLInputElement;
        const importButton = importContainer.querySelector('#url-import-btn') as HTMLInputElement;
        eventsManager.addEventListener(importForm, 'submit', async (e) => {
          e.preventDefault();
          importButton.innerHTML = 'Loading...';
          importButton.disabled = true;
          const url = (importContainer.querySelector('#code-url') as HTMLInputElement).value;
          const imported = await importCode(url, {}, defaultConfig);
          if (imported && Object.keys(imported).length > 0) {
            await loadConfig(
              {
                ...defaultConfig,
                ...imported,
              },
              location.origin + location.pathname + '#' + url,
            );
          } else {
            notifications.error('failed to load URL');
          }
          modal.close();
        });

        const importJsonUrlForm = importContainer.querySelector(
          '#json-url-import-form',
        ) as HTMLInputElement;
        const importJsonUrlButton = importContainer.querySelector(
          '#json-url-import-btn',
        ) as HTMLInputElement;
        eventsManager.addEventListener(importJsonUrlForm, 'submit', async (e) => {
          e.preventDefault();
          importJsonUrlButton.innerHTML = 'Loading...';
          importJsonUrlButton.disabled = true;
          const url = (importContainer.querySelector('#json-url') as HTMLInputElement).value;
          const fileConfig = await fetch(url)
            .then((res) => res.json())
            .catch(() => {
              modal.close();
              notifications.error('failed to load URL');
              return;
            });
          if (fileConfig) {
            await loadConfig(fileConfig, location.origin + location.pathname + '?config=' + url);
          }
          modal.close();
        });

        const fileInput = importContainer.querySelector('#file-input') as HTMLInputElement;

        eventsManager.addEventListener(fileInput, 'change', () => {
          if (fileInput.files?.length === 0) return;

          const file = (fileInput.files as FileList)[0];

          const allowedTypes = ['application/json', 'text/plain'];
          if (allowedTypes.indexOf(file.type) === -1) {
            modal.close();
            notifications.error('Error : Incorrect file type');
            return;
          }

          // Max 2 MB allowed
          const maxSizeAllowed = 2 * 1024 * 1024;
          if (file.size > maxSizeAllowed) {
            modal.close();
            notifications.error('Error : Exceeded size 2MB');
            return;
          }

          const reader = new FileReader();

          eventsManager.addEventListener(reader, 'load', async (event: any) => {
            const text = (event.target?.result as string) || '';
            try {
              await loadConfig(JSON.parse(text));
            } catch (error) {
              notifications.error('Invalid configuration file');
            }

            modal.close();
          });

          eventsManager.addEventListener(reader, 'error', () => {
            modal.close();
            notifications.error('Error : Failed to read file');
          });

          reader.readAsText(file);
        });

        modal.show(importContainer);
        (importContainer.querySelector('#code-url') as HTMLInputElement).focus();
      };

      eventsManager.addEventListener(
        document.querySelector('#import-link') as HTMLElement,
        'click',
        checkSavedAndExecute(createImportUI),
        false,
      );
    };

    const handleExport = () => {
      eventsManager.addEventListener(
        document.querySelector('#export-menu #export-json') as HTMLAnchorElement,
        'click',
        (event: Event) => {
          event.preventDefault();
          update();
          exportPen(getConfig(), 'json');
        },
        false,
      );

      eventsManager.addEventListener(
        document.querySelector('#export-menu #export-result') as HTMLAnchorElement,
        'click',
        async (event: Event) => {
          event.preventDefault();
          update();
          exportPen(getConfig(), 'html', await getResultPage(editors, true));
        },
        false,
      );

      let JSZip: any;
      eventsManager.addEventListener(
        document.querySelector('#export-menu #export-src') as HTMLAnchorElement,
        'click',
        async (event: Event) => {
          event.preventDefault();
          update();
          const html = await getResultPage(editors, true);
          exportPen(getConfig(), 'src', { JSZip, html, editors, getEditorLanguage });
        },
        false,
      );

      eventsManager.addEventListener(
        document.querySelector('#export-menu #export-codepen') as HTMLAnchorElement,
        'click',
        () => {
          update();
          exportPen(getConfig(), 'codepen');
        },
        false,
      );

      eventsManager.addEventListener(
        document.querySelector('#export-menu #export-jsfiddle') as HTMLAnchorElement,
        'click',
        () => {
          update();
          exportPen(getConfig(), 'jsfiddle');
        },
        false,
      );
    };

    const handleShare = () => {
      eventsManager.addEventListener(
        document.querySelector('#share-link') as HTMLAnchorElement,
        'click',
        (event: Event) => {
          event.preventDefault();
          share();
        },
        false,
      );
    };

    const handleExternalResources = () => {
      const createExrenalResourcesUI = () => {
        const div = document.createElement('div');
        div.innerHTML = resourcesScreen;
        const resourcesContainer = div.firstChild as HTMLElement;
        modal.show(resourcesContainer);

        const externalResources = resourcesContainer.querySelectorAll(
          '#resources-container textarea',
        ) as NodeListOf<HTMLTextAreaElement>;
        externalResources.forEach((textarea) => {
          const resourceContent = getConfig()[
            textarea.dataset.resource as 'stylesheets' | 'scripts'
          ];
          textarea.value = resourceContent.length !== 0 ? resourceContent.join('\n') + '\n' : '';
        });

        resourcesContainer.querySelector('textarea')?.focus();

        eventsManager.addEventListener(
          resourcesContainer.querySelector(
            '#resources-container #resources-load-btn',
          ) as HTMLElement,
          'click',
          async () => {
            externalResources.forEach((textarea) => {
              const resource = textarea.dataset.resource as 'stylesheets' | 'scripts';
              setConfig({
                ...getConfig(),
                [resource]:
                  textarea.value
                    ?.split('\n')
                    .map((x) => x.trim())
                    .filter((x) => x !== '') || [],
              });
            });
            setSavedStatus(false);
            modal.close();
            await run(editors);
          },
        );
      };
      eventsManager.addEventListener(
        document.querySelector('#external-resources-link') as HTMLElement,
        'click',
        createExrenalResourcesUI,
        false,
      );
    };

    const handleResultLoading = () => {
      eventsManager.addEventListener(window, 'message', (event: any) => {
        const iframe = document.querySelector(elements.result + ' > iframe') as HTMLIFrameElement;
        if (!iframe || event.source !== iframe.contentWindow || event.data.type !== 'loading') {
          return;
        }
        setLoading(event.data.payload);
      });
    };

    const handleUnload = () => {
      window.onbeforeunload = () => {
        if (!isSaved) {
          return 'Changes you made may not be saved.';
        } else {
          return;
        }
      };
    };

    handleTitleEdit();
    handleResize();
    handleIframeResize();
    handleSelectEditor();
    handlechangeLanguage();
    handleChangeContent();
    handleHotKeys();
    handleRunButton();
    handleSettings();
    handleExternalResources();
    handleNew();
    handleSave();
    handleFork();
    handleSaveAsTemplate();
    handleOpen();
    handleImport();
    handleExport();
    handleShare();
    handleResultLoading();
    handleUnload();
  };

  const loadSettings = (config: Pen) => {
    const autoupdateToggle = document.querySelector(
      '#settings-menu input#autoupdate',
    ) as HTMLInputElement;
    autoupdateToggle.checked = config.autoupdate;

    const autosaveToggle = document.querySelector(
      '#settings-menu input#autosave',
    ) as HTMLInputElement;
    autosaveToggle.checked = config.autosave;

    const autoprefixerToggle = document.querySelector(
      '#settings-menu input#autoprefixer',
    ) as HTMLInputElement;
    autoprefixerToggle.checked = config.autoprefixer;

    const emmetToggle = document.querySelector('#settings-menu input#emmet') as HTMLInputElement;
    emmetToggle.checked = config.emmet;

    (document.querySelectorAll('#css-preset-menu a') as NodeListOf<HTMLAnchorElement>).forEach(
      (link) => {
        link.classList.remove('active');
        if (config.cssPreset === link.dataset.preset) {
          link.classList.add('active');
        }
        if (!config.cssPreset && link.dataset.preset === 'none') {
          link.classList.add('active');
        }
      },
    );
  };

  const setActiveEditor = async (config: Pen) => {
    const language =
      getLanguageByAlias(config.language) || getLanguageByAlias(config.markup.language) || 'html';
    const editorId = getLanguageEditorId(language) || 'markup';
    if (getEditorLanguage(editorId) !== language) {
      await changeLanguage(editorId, language);
    }
    showEditor(editorId);
  };

  async function bootstrap(reload = false) {
    await createIframe(elements.result);

    if (!reload) {
      createLanguageMenus(getConfig(), modal, eventsManager);
      editors = await createEditors(getConfig());

      const toolList: ToolList = [
        {
          name: 'console',
          factory: createConsole,
        },
        {
          name: 'compiled',
          factory: createCompiledCodeViewer,
        },
      ];
      toolsPane = createToolsPane(toolList, getConfig(), editors, eventsManager);
      attachEventListeners(editors);
    } else {
      await updateEditors(editors, getConfig());
    }

    phpHelper({ editor: editors.script });
    setLoading(true);

    await loadModules(getConfig());
    await setActiveEditor(getConfig());
    loadSettings(getConfig());
    configureEmmet(getConfig());
    showMode(getConfig());
    setSavedStatus(true);
    await toolsPane?.load();
    updateCompiledCode();
    editors[activeEditorId].focus();

    compiler.load(Object.values(editorLanguages), getConfig()).then(async () => {
      await run(editors);
    });
    formatter.load(getEditorLanguages());
  }

  await bootstrap();

  return {
    run: async () => {
      await run(editors);
    },
    save: () => save(),
    getData: () => JSON.parse(JSON.stringify(getConfig())),
  };
};
