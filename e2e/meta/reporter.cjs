// Collects what the meta tests need (steps with locations, errors, attachments, stdout)
// into the JSON file named by PLP_META_OUT.
const fs = require('node:fs');

class MetaReporter {
  constructor() {
    this.tests = new Map();
  }

  entry(test) {
    const key = test.titlePath().join(' › ');
    if (!this.tests.has(key)) this.tests.set(key, { title: test.title, titlePath: test.titlePath(), results: [] });
    return this.tests.get(key);
  }

  onTestBegin(test, result) {
    const e = this.entry(test);
    result.__meta = { retry: result.retry, steps: [] };
    e.results.push(result.__meta);
  }

  onStepBegin(test, result, step) {
    if (!result.__meta) return;
    result.__meta.steps.push({
      title: step.title,
      category: step.category,
      file: step.location ? step.location.file : undefined,
      line: step.location ? step.location.line : undefined,
      parents: step.parent ? 1 : 0,
    });
  }

  onTestEnd(test, result) {
    const m = result.__meta;
    if (!m) return;
    m.status = result.status;
    m.expectedStatus = test.expectedStatus;
    m.duration = result.duration;
    m.errors = (result.errors || (result.error ? [result.error] : [])).map((er) => ({
      message: er.message,
      stack: er.stack,
      file: er.location ? er.location.file : undefined,
      line: er.location ? er.location.line : undefined,
    }));
    m.attachments = (result.attachments || []).map((a) => ({
      name: a.name,
      contentType: a.contentType,
      body: a.body ? a.body.toString('utf8') : (a.path ? safeRead(a.path) : undefined),
      path: a.path,
    }));
    m.stdout = result.stdout.map((c) => (typeof c === 'string' ? c : c.toString('utf8'))).join('');
    m.stderr = result.stderr.map((c) => (typeof c === 'string' ? c : c.toString('utf8'))).join('');
  }

  onEnd() {
    const out = process.env.PLP_META_OUT;
    if (out) fs.writeFileSync(out, JSON.stringify([...this.tests.values()], null, 1));
  }
}

function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

module.exports = MetaReporter;
