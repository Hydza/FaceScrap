import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';
import { createScanner } from 'typescript/unstable/ast/scanner';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXPECTED_AUTHOR = 'Hydza';
const RESTRICTED_TERMS = new Set(
  JSON.parse(
    Buffer.from(
      'WyJhaSIsImFydGlmaWNpYWwgaW50ZWxsaWdlbmNlIiwiZ2VuZXJhdGl2ZSBhaSIsIm1hY2hpbmUgbGVhcm5pbmciLCJkZWVwIGxlYXJuaW5nIiwibGFyZ2UgbGFuZ3VhZ2UgbW9kZWwiLCJsYW5ndWFnZSBtb2RlbCIsImxsbSIsIm9wZW5haSIsImNoYXRncHQiLCJncHQiLCJjb2RleCIsImNvcGlsb3QiLCJjbGF1ZGUiLCJhbnRocm9waWMiLCJnZW1pbmkiLCJncm9rIiwicGVycGxleGl0eSIsImRlZXBzZWVrIiwibGxhbWEiLCJtaXN0cmFsIiwibWlkam91cm5leSIsImRhbGwgZSIsImRhbGxlIiwic3RhYmxlIGRpZmZ1c2lvbiIsInF3ZW4iLCJvbGxhbWEiLCJuZXVyYWwgbmV0d29yayIsImludGVsaWdlbmNpYSBhcnRpZmljaWFsIl0=',
      'base64',
    ).toString('utf8'),
  ),
);
const MAX_TERM_WORDS = Math.max(...[...RESTRICTED_TERMS].map((term) => term.split(' ').length));

const NON_ENGLISH_STRONG_WORDS = new Set([
  'archivo',
  'archivos',
  'código',
  'codigo',
  'comentario',
  'comentarios',
  'corrige',
  'después',
  'despues',
  'eliminar',
  'evita',
  'función',
  'funcion',
  'innecesario',
  'ningún',
  'ningun',
  'ninguna',
  'porque',
  'prueba',
  'pruebas',
  'redundante',
  'viejo',
]);

const NON_ENGLISH_COMMON_WORDS = new Set([
  'antes',
  'aquí',
  'aqui',
  'con',
  'cuando',
  'debe',
  'deben',
  'desde',
  'donde',
  'esta',
  'estas',
  'este',
  'esto',
  'estos',
  'hasta',
  'para',
  'pero',
  'sin',
  'solo',
  'sólo',
]);

const HISTORY_PATTERNS = [
  /\bused to\b/i,
  /\bpreviously\b/i,
  /\bformerly\b/i,
  /\b(?:old|prior|previous) (?:behavior|behaviour|code|form|implementation|path|version)\b/i,
  /\b(?:deleted|removed) from (?:here|the|this)\b/i,
  /\bthis started as\b/i,
  /\buntil now\b/i,
  /\bno longer\b/i,
  /\bregression this fixes\b/i,
  /\bwas wrong\b/i,
];

const UNFINISHED_MARKER = /\b(?:FIXME|HACK|TBD|TODO|XXX)\b/i;
const COMMENTED_CODE_PATTERNS = [
  /^(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+[$\w]+\s*=/,
  /^(?:export\s+)?(?:async\s+)?function\s+[$\w]+\s*\(/,
  /^(?:export\s+)?(?:class|enum|interface|type)\s+[$\w]+/,
  /^(?:if|for|while|switch|catch)\s*\(/,
  /^import\s+.+\s+from\s+['"]/,
  /^(?:return|throw)\s+.+;/,
];

const SCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.json', '.jsonc', '.mjs', '.ts', '.tsx']);
const EXPRESSION_END_TOKENS = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.NumericLiteral,
  SyntaxKind.BigIntLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.RegularExpressionLiteral,
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
  SyntaxKind.ThisKeyword,
  SyntaxKind.CloseParenToken,
  SyntaxKind.CloseBracketToken,
  SyntaxKind.CloseBraceToken,
  SyntaxKind.PlusPlusToken,
  SyntaxKind.MinusMinusToken,
  SyntaxKind.TemplateTail,
]);
const BINARY_EXTENSIONS = new Set([
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mp4',
  '.pdf',
  '.png',
  '.ttf',
  '.webm',
  '.woff',
  '.woff2',
  '.zip',
]);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'artifacts', 'dist', 'node_modules']);

function wordsOf(value) {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export function findRestrictedTerms(value) {
  const words = wordsOf(value);
  const matches = [];

  for (let start = 0; start < words.length; start += 1) {
    let phrase = '';
    for (let length = 1; length <= MAX_TERM_WORDS && start + length <= words.length; length += 1) {
      phrase = phrase ? `${phrase} ${words[start + length - 1]}` : words[start];
      if (RESTRICTED_TERMS.has(phrase)) matches.push(phrase);
    }
  }

  return [...new Set(matches)];
}

function commentBody(value) {
  return value
    .replace(/^\s*\/\/+\s?/, '')
    .replace(/^\s*\/\*+\s?/, '')
    .replace(/\s*\*\/\s*$/, '')
    .replace(/^\s*<!--\s?/, '')
    .replace(/\s*-->\s*$/, '')
    .replace(/^\s*#\s?/gm, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
}

function proseOnly(value) {
  return value
    .replace(/`[^`]*`/gs, ' ')
    .replace(/"(?:\\.|[^"\\])*"/gs, ' ')
    .replace(/https?:\/\/\S+/gi, ' ');
}

function looksLikeCommentedCode(value) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => COMMENTED_CODE_PATTERNS.some((pattern) => pattern.test(line)));
}

export function analyzeComment(value) {
  const body = commentBody(value);
  if (!body) return [];

  const prose = proseOnly(body);
  const words = wordsOf(prose);
  const commonMatches = new Set(words.filter((word) => NON_ENGLISH_COMMON_WORDS.has(word)));
  const issues = [];

  if (
    /[áéíóúüñ¿¡]/i.test(prose) ||
    words.some((word) => NON_ENGLISH_STRONG_WORDS.has(word)) ||
    commonMatches.size >= 2
  ) {
    issues.push('Comment must use clear English.');
  }
  if (HISTORY_PATTERNS.some((pattern) => pattern.test(prose))) {
    issues.push('Comment describes obsolete implementation history.');
  }
  if (UNFINISHED_MARKER.test(prose)) {
    issues.push('Comment contains an unfinished-work marker.');
  }
  if (looksLikeCommentedCode(body)) {
    issues.push('Delete commented-out code.');
  }

  return issues;
}

function lineLocator(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= offset) low = middle;
      else high = middle;
    }
    return low + 1;
  };
}

function regexComments(source, pattern) {
  const locate = lineLocator(source);
  return [...source.matchAll(pattern)].map((match) => ({
    line: locate(match.index ?? 0),
    text: match[0],
  }));
}

export function collectComments(filePath, source) {
  const extension = extname(filePath).toLowerCase();

  if (SCRIPT_EXTENSIONS.has(extension)) {
    const scanner = createScanner(
      false,
      extension === '.jsx' || extension === '.tsx' ? LanguageVariant.JSX : LanguageVariant.Standard,
      source,
    );
    const locate = lineLocator(source);
    const comments = [];
    const templateBraceDepths = [];
    let previousToken;
    for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
      if (token === SyntaxKind.SlashToken && !EXPRESSION_END_TOKENS.has(previousToken)) {
        token = scanner.reScanSlashToken();
      }
      if (token === SyntaxKind.TemplateHead) {
        templateBraceDepths.push(0);
      } else if (templateBraceDepths.length > 0) {
        const top = templateBraceDepths.length - 1;
        if (token === SyntaxKind.OpenBraceToken) {
          templateBraceDepths[top] += 1;
        } else if (token === SyntaxKind.CloseBraceToken) {
          if (templateBraceDepths[top] > 0) {
            templateBraceDepths[top] -= 1;
          } else {
            token = scanner.reScanTemplateToken(false);
            if (token === SyntaxKind.TemplateTail) templateBraceDepths.pop();
          }
        }
      }
      if (token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia) {
        comments.push({ line: locate(scanner.getTokenStart()), text: scanner.getTokenText() });
      }
      if (scanner.getTokenEnd() <= scanner.getTokenStart()) {
        scanner.resetTokenState(Math.min(source.length, scanner.getTokenEnd() + 1));
      }
      if (
        token !== SyntaxKind.WhitespaceTrivia &&
        token !== SyntaxKind.NewLineTrivia &&
        token !== SyntaxKind.SingleLineCommentTrivia &&
        token !== SyntaxKind.MultiLineCommentTrivia
      ) {
        previousToken =
          token === SyntaxKind.TemplateHead || token === SyntaxKind.TemplateMiddle ? undefined : token;
      }
    }
    return comments;
  }

  if (extension === '.css') return regexComments(source, /\/\*[\s\S]*?\*\//g);
  if (extension === '.html' || extension === '.md' || extension === '.svg') {
    return regexComments(source, /<!--[\s\S]*?-->/g);
  }
  if (extension === '.yaml' || extension === '.yml') {
    return regexComments(source, /^\s*#(?!!).*$/gm);
  }
  if (['.editorconfig', '.gitattributes', '.gitignore'].some((name) => filePath.endsWith(name))) {
    return regexComments(source, /^\s*#(?!!).*$/gm);
  }

  return [];
}

export function validateAuthorMetadata({ packageAuthor, manifestAuthor, licenseText, historyAuthors }) {
  const issues = [];
  if (packageAuthor !== EXPECTED_AUTHOR) issues.push('package.json author must be Hydza.');
  if (manifestAuthor !== EXPECTED_AUTHOR) issues.push('manifest.json author must be Hydza.');
  const copyrightLines = licenseText.match(/^Copyright .*$/gm) ?? [];
  if (
    copyrightLines.length !== 1 ||
    !/^Copyright \(c\) \d{4}(?:-\d{4})? Hydza$/.test(copyrightLines[0])
  ) {
    issues.push('LICENSE must identify Hydza as the project copyright holder.');
  }
  if (historyAuthors.length === 0) issues.push('Git history has no author.');
  for (const author of new Set(historyAuthors)) {
    if (author !== EXPECTED_AUTHOR) issues.push(`Git author must be Hydza: ${author}`);
  }
  return issues;
}

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

function projectFiles(root) {
  const listed = runGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return [...new Set(listed.split('\0').filter(Boolean))]
    .map((filePath) => filePath.replaceAll('\\', '/'))
    .filter((filePath) => {
      const [first] = filePath.split('/');
      return !EXCLUDED_DIRECTORIES.has(first) && extname(filePath).toLowerCase() !== '.zip';
    })
    .sort();
}

function textFile(root, filePath) {
  if (BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) return undefined;
  const absolutePath = resolve(root, filePath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return undefined;
  const data = readFileSync(absolutePath);
  if (data.subarray(0, 8192).includes(0)) return undefined;
  return data.toString('utf8');
}

function authorIssues(root) {
  const packageManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const extensionManifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
  const historyRef = process.env.REPOSITORY_POLICY_HISTORY_REF || 'HEAD';
  const historyAuthors = runGit(root, ['log', historyRef, '--format=%an%x00'])
    .split('\0')
    .map((author) => author.trim())
    .filter(Boolean);
  return validateAuthorMetadata({
    packageAuthor: packageManifest.author,
    manifestAuthor: extensionManifest.author,
    licenseText: readFileSync(resolve(root, 'LICENSE'), 'utf8'),
    historyAuthors,
  });
}

export function inspectProject(root = ROOT) {
  const violations = authorIssues(root).map((message) => ({ filePath: 'repository', line: 0, message }));

  for (const filePath of projectFiles(root)) {
    const source = textFile(root, filePath);
    if (source === undefined) continue;

    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (findRestrictedTerms(line).length > 0) {
        violations.push({ filePath, line: index + 1, message: 'Restricted technology reference.' });
      }
    }

    for (const comment of collectComments(filePath, source)) {
      for (const message of analyzeComment(comment.text)) {
        violations.push({ filePath, line: comment.line, message });
      }
    }
  }

  return violations;
}

function main() {
  const violations = inspectProject();
  if (violations.length === 0) {
    console.log('Repository policy passed.');
    return;
  }

  for (const violation of violations) {
    const location = violation.line > 0 ? `${violation.filePath}:${violation.line}` : violation.filePath;
    console.error(`${location}: ${violation.message}`);
  }
  console.error(`${violations.length} repository policy violation(s).`);
  process.exitCode = 1;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedUrl === import.meta.url) main();
