import type { NextFunction, Request, Response } from 'express';

/**
 * Minimal multipart/form-data reader for provider webhooks.
 *
 * Mailgun posts a parsed inbound email as multipart/form-data — that is how
 * attachments ride along — and `express.urlencoded()` ignores that content
 * type, leaving `req.body` empty. The webhook then sees no sender and no text,
 * matches nothing, and answers 200, so the reply is dropped without a trace on
 * either side. This fills in the text fields so the handler has something to
 * match on.
 *
 * Only the field parts are kept. Attachment parts are skipped (inbound files
 * aren't stored anywhere), and the whole body is capped — a message bigger than
 * the cap is rejected loudly rather than parsed halfway.
 */

const DEFAULT_LIMIT_BYTES = 10 * 1024 * 1024;

function boundaryOf(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const raw = (match?.[1] ?? match?.[2] ?? '').trim();
  return raw || null;
}

function readBody(req: Request, limitBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        settle(() => reject(new Error('too-large')));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks))));
    req.on('error', (err) => settle(() => reject(err)));
  });
}

/**
 * Split a multipart body into its named text fields. Parts carrying a filename
 * are attachments and are reported by name only, so a 5 MB PDF never becomes a
 * 5 MB string.
 */
function parseFields(body: Buffer, boundary: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const attachments: string[] = [];
  const delimiter = Buffer.from(`--${boundary}`);

  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    const partStart = cursor + delimiter.length;
    // "--boundary--" closes the body; nothing meaningful follows it.
    if (body.subarray(partStart, partStart + 2).toString('latin1') === '--') break;

    const nextDelimiter = body.indexOf(delimiter, partStart);
    if (nextDelimiter < 0) break;

    // A part runs `CRLF <headers> CRLF CRLF <content> CRLF` between delimiters.
    const part = body.subarray(partStart, nextDelimiter);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const name = headers.match(/\bname="([^"]*)"/i)?.[1];
      const filename = headers.match(/\bfilename="([^"]*)"/i)?.[1];
      if (name) {
        if (filename !== undefined) {
          attachments.push(filename);
        } else {
          fields[name] = part.subarray(headerEnd + 4, part.length - 2).toString('utf8');
        }
      }
    }

    cursor = nextDelimiter;
  }

  if (attachments.length) fields['__attachmentNames'] = attachments.join(', ');
  return fields;
}

/**
 * Populate `req.body` from a multipart/form-data payload. A no-op for every
 * other content type, so it can sit in front of routes that also take JSON.
 */
export function multipartFormData(limitBytes: number = DEFAULT_LIMIT_BYTES) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const contentType = String(req.headers['content-type'] || '');
    if (!/^multipart\/form-data/i.test(contentType)) {
      next();
      return;
    }
    const boundary = boundaryOf(contentType);
    if (!boundary) {
      res.status(400).json({ success: false, error: 'Malformed multipart body (no boundary)' });
      return;
    }

    readBody(req, limitBytes)
      .then((body) => {
        req.body = { ...(req.body || {}), ...parseFields(body, boundary) };
        next();
      })
      .catch((err: Error) => {
        if (err.message === 'too-large') {
          res.status(413).json({
            success: false,
            error: `Multipart body exceeds ${Math.round(limitBytes / (1024 * 1024))}MB`,
          });
          return;
        }
        next(err);
      });
  };
}
