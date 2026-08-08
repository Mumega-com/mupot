# Cost estimate

**Bottom line up front: this workload will burn roughly $10-15 over the
full 27 days, not anything close to $300.** The $300 credit is not the
binding constraint here — see "What actually matters" below.

Numbers below use published Autopilot "Regular"/general-purpose compute
class rates for `us-central1` (~$0.0445/vCPU-hr, ~$0.0049/GiB-hr memory,
~$0.00014/GiB-hr ephemeral storage) with a **+10% buffer for the
Canadian-region premium**, since I could not pull a live, region-specific
rate for `northamerica-northeast1`/`-2` through the tools available to me
(pricing pages are JS-rendered; I did not run a billing-API query since
that's a live GCP call outside "prepare, don't provision"). **Verify the
real number with the pricing calculator (link below) before treating this
as gospel for the 27-day window** — the arithmetic style is right even if
the exact cents are off by some percent.

## Cluster management fee: effectively $0

GKE's $0.10/hr cluster fee (~$73/mo at 730 hrs) is covered by the
$74.40/mo **per-billing-account** GKE free-tier credit — this is separate
from, and does not draw down, the $300 promotional credit. It renews every
month on any billing account (trial or paid) and covers exactly one
Autopilot-or-zonal cluster. As long as `mumegaproject` doesn't also host a
second such cluster, this line is $0 out of pocket, indefinitely — not
just for 27 days.

## Pod compute (the only real spend here)

Requests in `k8s/20-deployment.yaml`: 250m CPU, 512Mi memory, 256Mi
ephemeral-storage, 1 replica, running continuously (Autopilot bills
requests, not actual usage, so idle time between Telegram messages costs
the same as busy time — there's no scale-to-zero on a long-poll workload
by design, see `DESIGN.md`).

| Resource | Requested | Rate (buffered) | Cost/hr |
|---|---|---|---|
| CPU | 0.25 vCPU | $0.0490/vCPU-hr | $0.01225 |
| Memory | 0.5 GiB | $0.00539/GiB-hr | $0.00270 |
| Ephemeral storage | 0.25 GiB | $0.000154/GiB-hr | $0.00004 |
| **Total** | | | **≈ $0.0150/hr** |

- Per day: ≈ **$0.36**
- Over 27 days: ≈ **$9.72**
- Over a full 30-day month (if kept running past day 27): ≈ **$10.80**

## Everything else (rounding error)

- **Artifact Registry storage**: locally built and measured at **230MB**
  (`docker images` size, `node:22-alpine` base + a ~10KB script — no
  `node_modules`, zero dependencies). Compressed-on-push will be smaller.
  At ~$0.10/GB-month that's ≈ $0.02/mo — not tracked further.
- **Secret Manager**: $0.03/active-secret-version/month × 2 secrets =
  $0.06/mo, plus access-operation charges. At one boot fetch + a refresh
  every 30 min, that's ~48 accesses/day × 2 secrets ≈ 96/day ≈ 2,600 over
  27 days — inside Secret Manager's free monthly access-operation
  allowance. Effectively $0.
- **Network egress**: outbound calls are small JSON payloads to
  `api.telegram.org`, the pot (Cloudflare), and `secretmanager.googleapis.com`.
  At realistic DME message volume this is kilobytes/day, inside the free
  egress tier. Effectively $0.
- **No LoadBalancer/Ingress** (see `DESIGN.md` — long-poll, not webhook) —
  the ~$18-20/mo forwarding-rule fee that mode would cost does not apply.

## What actually matters more than the $300 number

The $300 credit will barely be touched by this workload — the real
constraint is **the trial's calendar expiration**, not the dollar balance.
Two things to nail down before day 27, not a cost problem to solve:

1. Confirm whether `mumegaproject`'s Cloud Billing account is a **free
   trial** account or already a standard pay-as-you-go account with a $300
   promotional credit applied. These behave differently at expiration.
2. If it's a free-trial account: GCP's documented behavior is that at
   trial expiration, **resources are not immediately billed further nor
   immediately deleted** — the account must be explicitly upgraded to a
   paid Cloud Billing account to keep running past that date; unupgraded
   trial accounts have running compute paused. Confirm the current exact
   grace-period behavior at
   https://cloud.google.com/free/docs/free-cloud-features before day 27 —
   I'm not asserting a precise retention window here because I have not
   verified it against the account's actual trial-vs-paid status, and
   getting this wrong is a "wake up to a paused DME Telegram bot" risk,
   not a security risk, but still worth a calendar reminder now.
3. **If/when upgraded to a paid account**, the ongoing monthly cost for
   this specific workload is the ~$10-15/mo pod-compute number above,
   forever — cheap enough that "is it worth keeping running" is a product
   decision, not a budget one.

## Verify before trusting this for real money

```bash
# Live, current, region-exact rates — read-only, no resources created:
open "https://cloud.google.com/products/calculator"
# Or, once the cluster exists, check actual spend after 24-48h:
gcloud billing accounts list
gcloud billing budgets list --billing-account=<ACCOUNT_ID>
```
