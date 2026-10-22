import { Injectable } from '@nestjs/common';
import * as http from 'node:http';
import * as https from 'node:https';
import type { HttpFetcher } from '../sync.types';

const MAX_REDIRECTS = 3;

/** JSON GET عبر node:http(s) فقط — قابل للحقن حتى تُستبدل في الاختبارات. */
@Injectable()
export class NodeHttpFetcher implements HttpFetcher {
  async getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
    return this.requestJson(url, headers, MAX_REDIRECTS);
  }

  private requestJson(url: string, headers: Record<string, string>, redirectsLeft: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        reject(new Error(`BAD_SOURCE_URL: ${url}`));
        return;
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        reject(new Error(`BAD_SOURCE_URL: only http(s) allowed, got ${target.protocol}`));
        return;
      }
      const lib = target.protocol === 'https:' ? https : http;
      const req = lib.get(
        target,
        { headers: { accept: 'application/json', ...headers }, timeout: 15_000 },
        (res) => {
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
            res.resume();
            resolve(this.requestJson(new URL(location, target).toString(), headers, redirectsLeft - 1));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > 25 * 1024 * 1024) {
              req.destroy(new Error('REST_RESPONSE_TOO_LARGE'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (status >= 400) {
              reject(new Error(`REST_FETCH_FAILED: HTTP ${status} from ${target.origin}${target.pathname}`));
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new Error(`REST_FETCH_FAILED: response is not JSON (${target.origin}${target.pathname})`));
            }
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('REST_FETCH_TIMEOUT')));
      req.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
    });
  }
}
