import { describe, expect, it, vi } from 'vitest';

import DreoAPI from '../src/DreoAPI';
import type { DreoPlatform } from '../src/platform';

describe('DreoAPI logging', () => {
  it('does not log request headers, tokens, or request bodies from Axios errors', () => {
    const errorLog = vi.fn();
    const api = new DreoAPI({
      config: {
        options: {
          email: 'user@example.invalid',
          password: 'not-a-real-password',
        },
      },
      log: {
        error: errorLog,
      },
    } as unknown as DreoPlatform);

    const axiosError = {
      isAxiosError: true,
      code: 'ERR_BAD_RESPONSE',
      message: 'Request failed with status code 401',
      response: {
        status: 401,
      },
      config: {
        headers: {
          authorization: 'Bearer sensitive-token',
        },
        data: {
          password: 'sensitive-password-hash',
        },
      },
    };

    const privateApi = api as unknown as {
      logRequestError(context: string, error: unknown): void;
    };
    privateApi.logRequestError('authentication failed', axiosError);

    expect(errorLog).toHaveBeenCalledWith(
      'authentication failed: HTTP 401, ERR_BAD_RESPONSE, Request failed with status code 401',
    );
    const loggedValue = JSON.stringify(errorLog.mock.calls);
    expect(loggedValue).not.toContain('sensitive-token');
    expect(loggedValue).not.toContain('sensitive-password-hash');
  });
});
