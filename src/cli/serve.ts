// GET /cli - serves cli/mupot.mjs (the zero-dependency mupot command-line client) as the exact
// bytes checked into the repo. Public and unauthenticated by design: the file is the same
// open-source script, and `X-Content-SHA256` lets an installer verify the download against
// `mupot --version`. Mounted next to /health in src/index.ts, ahead of every auth layer, and
// it reads no request state.

import { CLI_SHA256, CLI_SOURCE } from './bundle.generated'

export function cliResponse(): Response {
  return new Response(CLI_SOURCE, {
    status: 200,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'x-content-sha256': CLI_SHA256,
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  })
}
