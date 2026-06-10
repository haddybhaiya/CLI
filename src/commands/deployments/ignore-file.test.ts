import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDeployIgnore } from './ignore-file.js';
import { collectDeploymentFiles } from './deploy.js';

const tempDirs: string[] = [];

async function makeTempProject(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'insforge-ignore-test-'));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(dir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content);
  }
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('loadDeployIgnore', () => {
  it('returns null when .vercelignore does not exist', async () => {
    const dir = await makeTempProject({ 'index.html': '<html></html>' });
    expect(await loadDeployIgnore(dir)).toBeNull();
  });

  it('parses patterns and counts non-comment lines', async () => {
    const dir = await makeTempProject({
      '.vercelignore': '# comment\n\n*.md\ndocs/\n',
    });
    const matcher = await loadDeployIgnore(dir);
    expect(matcher).not.toBeNull();
    expect(matcher?.patternCount).toBe(2);
    expect(matcher?.ignores('README.md')).toBe(true);
    expect(matcher?.ignores('docs/guide.txt')).toBe(true);
    expect(matcher?.ignores('index.html')).toBe(false);
  });

  it('supports negation patterns', async () => {
    const dir = await makeTempProject({
      '.vercelignore': '*.md\n!KEEP.md\n',
    });
    const matcher = await loadDeployIgnore(dir);
    expect(matcher?.ignores('README.md')).toBe(true);
    expect(matcher?.ignores('KEEP.md')).toBe(false);
  });

  it('handles CRLF line endings', async () => {
    const dir = await makeTempProject({
      '.vercelignore': '*.tmp\r\nprivate/\r\n',
    });
    const matcher = await loadDeployIgnore(dir);
    expect(matcher?.patternCount).toBe(2);
    expect(matcher?.ignores('a.tmp')).toBe(true);
    expect(matcher?.ignores('private/data.json')).toBe(true);
  });
});

describe('collectDeploymentFiles with .vercelignore', () => {
  it('excludes files and directories matched by the ignore file', async () => {
    const dir = await makeTempProject({
      '.vercelignore': '*.md\ndrafts/\n',
      'index.html': '<html></html>',
      'README.md': '# readme',
      'drafts/wip.txt': 'wip',
      'src/app.js': 'console.log(1)',
    });
    const matcher = await loadDeployIgnore(dir);
    const files = await collectDeploymentFiles(dir, matcher);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['index.html', 'src/app.js']);
  });

  it('never uploads the .vercelignore file itself', async () => {
    const dir = await makeTempProject({
      '.vercelignore': '*.tmp\n',
      'index.html': '<html></html>',
    });
    const matcher = await loadDeployIgnore(dir);
    const files = await collectDeploymentFiles(dir, matcher);
    expect(files.map((f) => f.path)).toEqual(['index.html']);
  });

  it('built-in excludes still apply and cannot be re-included by negation', async () => {
    const dir = await makeTempProject({
      '.vercelignore': '!.env\n!node_modules\n',
      '.env': 'SECRET=1',
      'node_modules/pkg/index.js': 'x',
      'index.html': '<html></html>',
    });
    const matcher = await loadDeployIgnore(dir);
    const files = await collectDeploymentFiles(dir, matcher);
    expect(files.map((f) => f.path)).toEqual(['index.html']);
  });

  it('aggressive negation cannot re-include built-in excludes at any depth', async () => {
    const dir = await makeTempProject({
      '.vercelignore': '!**\n!node_modules/**\n!packages/app/node_modules\n!.env\n!**/.env\n!debug.log\n',
      '.env': 'SECRET=1',
      'debug.log': 'log',
      'node_modules/pkg/index.js': 'x',
      'packages/app/node_modules/dep/index.js': 'x',
      'packages/app/.env': 'SECRET=2',
      'packages/app/src/main.ts': 'code',
      'index.html': '<html></html>',
    });
    const matcher = await loadDeployIgnore(dir);
    const files = await collectDeploymentFiles(dir, matcher);
    expect(files.map((f) => f.path).sort()).toEqual(['index.html', 'packages/app/src/main.ts']);
  });

  it('vercelignore adds excludes on top of built-ins (union), it never replaces them', async () => {
    const dir = await makeTempProject({
      '.vercelignore': 'docs/\n',
      'node_modules/pkg/index.js': 'x',
      'docs/guide.md': 'doc',
      'index.html': '<html></html>',
    });
    const matcher = await loadDeployIgnore(dir);
    const files = await collectDeploymentFiles(dir, matcher);
    expect(files.map((f) => f.path)).toEqual(['index.html']);
  });

  it('behaves as before when no ignore file is present', async () => {
    const dir = await makeTempProject({
      'index.html': '<html></html>',
      'README.md': '# readme',
    });
    const matcher = await loadDeployIgnore(dir);
    expect(matcher).toBeNull();
    const files = await collectDeploymentFiles(dir, matcher);
    expect(files.map((f) => f.path).sort()).toEqual(['README.md', 'index.html']);
  });
});
