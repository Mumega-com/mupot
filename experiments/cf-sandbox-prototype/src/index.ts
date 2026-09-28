import { getSandbox, Sandbox } from '@cloudflare/sandbox'

export { Sandbox }

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>
  PROTO_TEST_SECRET?: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const sandbox = getSandbox(env.Sandbox, 'kasra-prototype-run')

    if (url.pathname === '/probe') {
      // Proves the exact primitive cursor-worker.py needs, in order:
      //  1. secrets reach the sandbox (setEnvVars)
      //  2. a real repo can be cloned inside it (gitCheckout)
      //  3. commands run against the checked-out tree (exec, cwd-scoped)
      // Nothing here touches mupot's live Worker/config — standalone project.
      await sandbox.setEnvVars({
        PROTO_TEST_SECRET: env.PROTO_TEST_SECRET ?? 'no-secret-bound',
      })

      const checkout = await sandbox.gitCheckout(
        'https://github.com/cloudflare/sandbox-sdk',
        { branch: 'main', targetDir: '/workspace/repo', depth: 1 },
      )

      const toolVersions = await sandbox.exec(
        'node --version && npm --version && git --version && gh --version | head -1',
      )

      const repoProof = await sandbox.exec(
        'git log -1 --oneline && echo "---" && ls | head -10',
        { cwd: '/workspace/repo' },
      )

      const secretProof = await sandbox.exec('echo "secret seen: $PROTO_TEST_SECRET"')

      return Response.json({
        checkout,
        toolVersions: { success: toolVersions.success, stdout: toolVersions.stdout, stderr: toolVersions.stderr },
        repoProof: { success: repoProof.success, stdout: repoProof.stdout, stderr: repoProof.stderr },
        secretProof: { success: secretProof.success, stdout: secretProof.stdout },
      })
    }

    return new Response('Try /probe')
  },
}
