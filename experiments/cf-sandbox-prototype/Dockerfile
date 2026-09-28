FROM docker.io/cloudflare/sandbox:0.12.4

# Base image already ships git/curl/ca-certificates (confirmed via build log,
# 2026-07-22). Proving gitCheckout+exec+setEnvVars needs nothing else — this
# host's egress to archive.ubuntu.com is unreachable right now (confirmed via
# direct curl, while docker.io/github.com are fine), so avoid apt entirely for
# this probe. gh CLI install (needed for the later full cursor-worker proof)
# gets a static-binary install in a follow-up, not apt, to sidestep this.

EXPOSE 8080
