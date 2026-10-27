// Visual harness only: the error the fake backend throws; `fake-transport.ts` turns it into an
// `{ error, message }` answer with the matching HTTP status.

import type { ApiErrorCode } from '../../../src/shared/api.ts';

export class ServiceError extends Error {
  readonly code: ApiErrorCode | 'network' | 'timeout' | 'unavailable';

  constructor(code: ServiceError['code'], message: string) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}
