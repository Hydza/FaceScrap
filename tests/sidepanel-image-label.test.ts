import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const controller = readFileSync(
  join(process.cwd(), 'src', 'sidepanel', 'sidepanel.ts'),
  'utf8',
);
const i18n = readFileSync(join(process.cwd(), 'src', 'shared', 'i18n.ts'), 'utf8');

interface DeclaredFunction {
  name: string;
  body: string;
}

function declaredFunctions(source: string): DeclaredFunction[] {
  const declaration =
    /function\s+([A-Za-z_$][\w$]*)\s*\(\s*kind\s*:\s*MediaKind\s*,\s*source\s*:\s*MediaSource\s*\)\s*:\s*MsgKey\s*\{/g;
  const functions: DeclaredFunction[] = [];

  for (const match of source.matchAll(declaration)) {
    const bodyStart = match.index! + match[0].length;
    let depth = 1;
    let cursor = bodyStart;
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '{') depth += 1;
      if (source[cursor] === '}') depth -= 1;
      cursor += 1;
    }
    assert.equal(depth, 0, `unterminated function ${match[1]}`);
    functions.push({ name: match[1]!, body: source.slice(bodyStart, cursor - 1) });
  }

  return functions;
}

function imageAwarePresentationResolver(): DeclaredFunction {
  const resolver = declaredFunctions(controller).find(
    ({ body }) => body.includes('kindImage') && body.includes('SOURCE_KEY'),
  );
  assert.ok(
    resolver,
    'sidepanel must define one image-aware presentation resolver from MediaKind + MediaSource',
  );
  return resolver;
}

function evaluateResolver(body: string): (kind: string, source: string) => string {
  const sourceKeys = {
    reel: 'sourceReel',
    story: 'sourceStory',
    highlight: 'sourceHighlight',
    video: 'sourceVideo',
    page: 'sourcePage',
  };
  return Function(
    'SOURCE_KEY',
    `"use strict"; return function (kind, source) {${body}};`,
  )(sourceKeys) as (kind: string, source: string) => string;
}

function localizedValues(key: string): string[] {
  return [...i18n.matchAll(new RegExp(`^\\s*${key}: '([^']*)',`, 'gm'))].map(
    (match) => match[1]!,
  );
}

test('image presentation uses Image/Imagen even when its contextual source is video', () => {
  const resolve = evaluateResolver(imageAwarePresentationResolver().body);
  const cases = [
    { kind: 'image', source: 'video', key: 'kindImage', en: 'Image', es: 'Imagen' },
    { kind: 'video', source: 'video', key: 'sourceVideo', en: 'Video', es: 'Video' },
    { kind: 'image', source: 'reel', key: 'sourceReel', en: 'Reel', es: 'Reel' },
    { kind: 'image', source: 'story', key: 'sourceStory', en: 'Story', es: 'Historia' },
    {
      kind: 'image',
      source: 'highlight',
      key: 'sourceHighlight',
      en: 'Highlight',
      es: 'Destacada',
    },
  ] as const;

  for (const item of cases) {
    const key = resolve(item.kind, item.source);
    assert.equal(key, item.key, `${item.kind}/${item.source} presentation key`);
    assert.deepEqual(
      localizedValues(key),
      [item.en, item.es],
      `${item.kind}/${item.source} English and Spanish labels`,
    );
  }
});

test('Library title and Now Playing badge/title use the same presentation resolver', () => {
  const { name } = imageAwarePresentationResolver();
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  assert.match(
    controller,
    new RegExp(
      String.raw`title\.textContent\s*=\s*t\(\s*${escapedName}\(\s*card\.kind\s*,\s*card\.source\s*\)\s*\)`,
    ),
    'Library card title must use the shared presentation resolver',
  );
  for (const id of ['now-badge', 'now-title']) {
    assert.match(
      controller,
      new RegExp(
        String.raw`byId\('${id}'\)\.textContent\s*=\s*t\(\s*${escapedName}\(\s*now\.kind\s*,\s*now\.source\s*\)\s*\)`,
      ),
      `#${id} must use the same presentation resolver as Library`,
    );
  }
});
