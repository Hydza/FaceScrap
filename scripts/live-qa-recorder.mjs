import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { redactUrl, sanitizeData, sanitizeText } from './live-qa-core.mjs';

export function createSessionRecorder(eventsPath) {
  const stream = createWriteStream(eventsPath, { flags: 'a', encoding: 'utf8' });
  const counts = { events: 0, errors: 0, warnings: 0 };
  let writeError;
  stream.on('error', (error) => {
    writeError = error;
  });

  const record = (event) => {
    const entry = {
      at: new Date().toISOString(),
      level: event.level,
      kind: event.kind,
      context: event.context,
      text: sanitizeText(event.text),
    };
    if (event.sourceUrl) entry.sourceUrl = redactUrl(event.sourceUrl);
    if (event.correlation) entry.correlation = sanitizeText(event.correlation);
    const data = sanitizeData(event.data);
    if (data != null) entry.data = data;
    stream.write(`${JSON.stringify(entry)}\n`);
    counts.events += 1;
    if (entry.level === 'error') counts.errors += 1;
    if (entry.level === 'warn') counts.warnings += 1;
    if (
      entry.level !== 'info' ||
      entry.kind === 'target-attached' ||
      entry.kind === 'target-detached' ||
      entry.kind.startsWith('download')
    ) {
      process.stdout.write(
        `[${entry.at}] ${entry.level.toUpperCase()} ${entry.context}/${entry.kind}: ${entry.text}\n`,
      );
    }
  };

  const close = async () => {
    stream.end();
    await once(stream, 'finish');
    if (writeError) throw writeError;
  };

  return { record, close, counts };
}
