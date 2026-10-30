// TypeDoc plugin: give the two entry points readable names and a one-line description of the
// import path, instead of the file names ("index", "fixtures").
import { Comment, Converter } from 'typedoc';

const MODULES = {
  index: {
    name: 'playwright-logger-pro',
    summary: "Entry point `import … from 'playwright-logger-pro'`: wrapRequestContext, config defaults, formatting and redaction helpers, attachBrowserLogger.",
  },
  fixtures: {
    name: 'fixtures',
    summary: "Entry point `import { test, expect } from 'playwright-logger-pro/fixtures'`: the drop-in `test` with both loggers, option types and mergeTests.",
  },
};

export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const child of context.project.children ?? []) {
      const info = MODULES[child.name];
      if (!info) continue;
      child.name = info.name;
      child.comment = new Comment([{ kind: 'text', text: info.summary }]);
    }
  });
}
