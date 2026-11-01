import { Writable } from 'node:stream';

const sensitiveKey = /secret|token|password|key|cipher|authorization/i;

export function redact(value: unknown, secrets: readonly string[] = [], seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) {
      if (secret) result = result.split(secret).join('***');
    }
    return result
      .replace(/\b(?:postgres(?:ql)?):\/\/[^\s]+/gi, '***')
      .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 ***')
      .replace(/((?:secret|token|password|key|cipher|authorization)[\w-]*\s*[=:]\s*)[^\s&,;]+/gi, '$1***');
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map(item => redact(item, secrets, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveKey.test(key) ? '***' : redact(item, secrets, seen)]));
  seen.delete(value);
  return result;
}

export function createLogStream(destination: NodeJS.WritableStream = process.stdout, env: NodeJS.ProcessEnv = process.env): Writable {
  const secrets = Object.entries(env)
    .filter(([key]) => sensitiveKey.test(key) || key === 'DATABASE_URL')
    .map(([, value]) => value ?? '').filter(Boolean);
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          destination.write(`${JSON.stringify(redact(JSON.parse(line), secrets))}\n`);
        }
        callback();
      } catch {
        // Never forward raw text if structured logging fails.
        destination.write('{"level":50,"msg":"Log serialization failed"}\n');
        callback();
      }
    },
  });
}
