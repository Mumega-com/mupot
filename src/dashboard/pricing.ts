// src/dashboard/pricing.ts — Public Pricing & Sovereign Pot Self-Serve Onboarding Portal.

import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'

export function pricingPageHtml(origin: string = 'https://mupot.mumega.com'): HtmlEscapedString {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mupot — Sovereign Agent Pots & Pricing</title>
    <style>
      :root {
        --bg: #09090b;
        --panel: #111116;
        --raised: #181820;
        --line: rgba(255,255,255,.08);
        --text: #f4f1ea;
        --muted: #9aa3b2;
        --gold: #d4a017;
        --cyan: #22d3ee;
        --magenta: #e879f9;
        --ok: #3dd68c;
        --font-display: 'Instrument Serif', Georgia, serif;
        --font-body: 'Hanken Grotesk', system-ui, sans-serif;
        --font-mono: 'JetBrains Mono', ui-monospace, monospace;
      }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body {
        background: var(--bg); color: var(--text); font-family: var(--font-body);
        -webkit-font-smoothing: antialiased; padding: 48px 24px; min-height: 100vh;
        display: flex; flex-direction: column; align-items: center;
      }
      .container { max-width: 1100px; width: 100%; }
      header { text-align: center; margin-bottom: 48px; }
      .kicker { font-family: var(--font-mono); color: var(--cyan); font-size: 12px; letter-spacing: .15em; text-transform: uppercase; margin-bottom: 12px; }
      h1 { font-family: var(--font-display); font-size: clamp(38px, 6vw, 64px); line-height: 1.05; margin-bottom: 16px; }
      .subtitle { color: var(--muted); font-size: 18px; max-width: 600px; margin: 0 auto; line-height: 1.5; }
      .slug-card {
        background: var(--panel); border: 1px solid var(--line); border-radius: 16px;
        padding: 24px 32px; margin-bottom: 48px; display: flex; flex-direction: column; gap: 16px;
      }
      .slug-label { font-size: 14px; font-weight: 600; color: var(--text); }
      .slug-input-wrap {
        display: flex; align-items: center; background: var(--raised);
        border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; gap: 8px; font-family: var(--font-mono);
      }
      .slug-prefix, .slug-suffix { color: var(--muted); font-size: 15px; }
      .slug-input {
        background: transparent; border: 0; color: var(--cyan); font-family: var(--font-mono);
        font-size: 16px; font-weight: 700; flex: 1; outline: none;
      }
      .pricing-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; }
      .tier-card {
        background: var(--panel); border: 1px solid var(--line); border-radius: 18px;
        padding: 32px 24px; display: flex; flex-direction: column; position: relative;
        transition: transform .2s ease, border-color .2s ease;
      }
      .tier-card:hover { transform: translateY(-4px); border-color: rgba(34,211,238,.3); }
      .tier-card.is-popular { border-color: var(--cyan); box-shadow: 0 0 30px rgba(34,211,238,.12); }
      .tier-badge {
        position: absolute; top: 16px; right: 16px; background: rgba(34,211,238,.15);
        color: var(--cyan); font-family: var(--font-mono); font-size: 10px; font-weight: 700;
        padding: 4px 8px; border-radius: 999px; text-transform: uppercase;
      }
      .tier-name { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
      .tier-price { font-family: var(--font-display); font-size: 44px; margin-bottom: 16px; }
      .tier-period { font-size: 14px; color: var(--muted); font-family: var(--font-body); }
      .tier-desc { color: var(--muted); font-size: 14px; margin-bottom: 24px; line-height: 1.45; }
      .tier-features { list-style: none; display: grid; gap: 12px; margin-bottom: 32px; flex: 1; font-size: 14px; }
      .tier-feature { display: flex; align-items: center; gap: 8px; }
      .tier-feature::before { content: '✓'; color: var(--ok); font-weight: 700; }
      .tier-cta {
        background: linear-gradient(135deg, var(--cyan), #67e8f9); color: #061014;
        border: 0; border-radius: 999px; padding: 14px 20px; font-weight: 700; font-size: 15px;
        cursor: pointer; text-align: center; text-decoration: none; display: block;
      }
      .tier-card:not(.is-popular) .tier-cta { background: var(--raised); color: var(--text); border: 1px solid var(--line); }
      .tier-card:not(.is-popular) .tier-cta:hover { background: rgba(255,255,255,.08); }
    </style>
  </head>
  <body>
    <div class="container">
      <header>
        <p class="kicker">Mupot Autonomous Cloud</p>
        <h1>Your Sovereign Agent Workforce.</h1>
        <p class="subtitle">Isolated edge database, custom domain routing, AES-256 encrypted vault, and 24/7 autonomous agent execution.</p>
      </header>

      <div class="slug-card">
        <label class="slug-label" for="pot-slug">1. Choose your sovereign pot subdomain</label>
        <div class="slug-input-wrap">
          <span class="slug-prefix">https://</span>
          <input type="text" id="pot-slug" class="slug-input" placeholder="yourcompany" maxlength="32" value="acme" />
          <span class="slug-suffix">.mupot.mumega.com</span>
        </div>
      </div>

      <div class="pricing-grid">
        <div class="tier-card">
          <h2 class="tier-name">Starter</h2>
          <div class="tier-price">$49 <span class="tier-period">/ month</span></div>
          <p class="tier-desc">Ideal for small engineering teams automating routine workflows and monitoring.</p>
          <ul class="tier-features">
            <li class="tier-feature">5 Active Autonomous Agents</li>
            <li class="tier-feature">3 Squads & 2 Departments</li>
            <li class="tier-feature">Isolated Cloudflare D1 Vault</li>
            <li class="tier-feature">Studio Dark Canvas UI</li>
          </ul>
          <button type="button" class="tier-cta" data-tier="starter">Launch Starter Pot</button>
        </div>

        <div class="tier-card is-popular">
          <span class="tier-badge">Most Popular</span>
          <h2 class="tier-name">Pro</h2>
          <div class="tier-price">$99 <span class="tier-period">/ month</span></div>
          <p class="tier-desc">Full-scale autonomous workforce with 1-click database connectors and external notifications.</p>
          <ul class="tier-features">
            <li class="tier-feature">15 Active Autonomous Agents</li>
            <li class="tier-feature">10 Squads & 5 Departments</li>
            <li class="tier-feature">1-Click Supabase Data Sync</li>
            <li class="tier-feature">Slack & Discord Outbound Alerts</li>
            <li class="tier-feature">Custom Domain & SSL Routing</li>
          </ul>
          <button type="button" class="tier-cta" data-tier="pro">Launch Pro Pot</button>
        </div>

        <div class="tier-card">
          <h2 class="tier-name">Scale</h2>
          <div class="tier-price">$249 <span class="tier-period">/ month</span></div>
          <p class="tier-desc">Enterprise sovereign isolate with unlimited capacity, SSO enforcement, and custom SLA.</p>
          <ul class="tier-features">
            <li class="tier-feature">Unlimited Agents & Squads</li>
            <li class="tier-feature">Dedicated Dispatch Isolate</li>
            <li class="tier-feature">Google & SAML SSO Auto-Enrollment</li>
            <li class="tier-feature">24/7 Autonomous Cron Routines</li>
            <li class="tier-feature">Synthetic Council Athena Reviews</li>
          </ul>
          <button type="button" class="tier-cta" data-tier="scale">Launch Scale Pot</button>
        </div>
      </div>
    </div>
    <script>
      document.querySelectorAll('.tier-cta').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          var tier = btn.getAttribute('data-tier');
          var slug = (document.getElementById('pot-slug').value || '').trim();
          if (!slug) { alert('Please enter a pot subdomain.'); return; }
          var email = prompt('Enter your corporate email for pot ownership:');
          if (!email) return;

          btn.textContent = 'Redirecting to Stripe…';
          btn.disabled = true;
          try {
            var res = await fetch('/api/pots/checkout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ slug: slug, tier: tier, owner_email: email, brand: slug.toUpperCase() })
            });
            var json = await res.json();
            if (json.ok && json.url) {
              window.location.href = json.url;
            } else {
              alert('Checkout failed: ' + (json.error || 'Unknown error'));
              btn.textContent = 'Launch ' + tier.toUpperCase() + ' Pot';
              btn.disabled = false;
            }
          } catch (e) {
            alert('Failed to connect to checkout server.');
            btn.disabled = false;
          }
        });
      });
    </script>
  </body>
</html>`
}
