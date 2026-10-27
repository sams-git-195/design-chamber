// Visual harness only: the HTML the fake backend "renders" for its sample designs. Self-contained pages
// with inline CSS (what the real bundler would hand the guest after inlining assets).

export type Palette = { bg: string; ink: string; accent: string; soft: string; card: string };

export const COFFEE: Palette = { bg: '#f6efe6', ink: '#2b1d14', accent: '#b4532a', soft: '#e9dccb', card: '#fffaf3' };
export const SLATE: Palette = { bg: '#f4f6fa', ink: '#18202f', accent: '#2f5bd8', soft: '#dfe6f4', card: '#ffffff' };
export const SAGE: Palette = { bg: '#eef2ea', ink: '#1f2b20', accent: '#3d7a4f', soft: '#d6e1cf', card: '#fbfdf9' };

const base = (p: Palette, title: string, body: string, extra = ''): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:${p.bg};color:${p.ink};font:16px/1.5 Georgia,'Times New Roman',serif}
h1,h2,h3{font-weight:600;letter-spacing:-.01em;line-height:1.1;margin:0}
.sans{font-family:'Segoe UI',system-ui,sans-serif}
nav{display:flex;align-items:center;justify-content:space-between;padding:22px 56px;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px}
nav b{font-family:Georgia,serif;font-size:22px;letter-spacing:-.02em}
nav ul{display:flex;gap:28px;list-style:none;margin:0;padding:0}
nav a{color:inherit;text-decoration:none}
.btn{display:inline-block;background:${p.accent};color:#fff;padding:13px 24px;border-radius:999px;font:600 14px 'Segoe UI',system-ui,sans-serif;text-decoration:none;border:0;cursor:pointer}
.btn.ghost{background:transparent;color:${p.ink};border:1.5px solid ${p.ink}}
section{padding:56px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.card{background:${p.card};border-radius:18px;padding:28px;border:1px solid ${p.soft}}
@media (max-width:640px){nav{padding:16px 20px}nav ul{display:none}section{padding:32px 20px}.grid{grid-template-columns:1fr}h1{font-size:38px!important}}
${extra}
</style></head><body>${body}</body></html>`;

const nav = (name: string, here: string): string => `<nav><b>${name}</b><ul>
<li><a href="home.html"${here === 'home' ? ' style="font-weight:700"' : ''}>Roasts</a></li>
<li><a href="pricing.html"${here === 'pricing' ? ' style="font-weight:700"' : ''}>Plans</a></li>
<li><a href="#">Journal</a></li></ul><a class="btn" href="checkout.html" data-dc-goto="checkout">Subscribe</a></nav>`;

export const coffeeHome = (): string =>
  base(
    COFFEE,
    'Ember & Oak — Home',
    `${nav('Ember &amp; Oak', 'home')}
<section style="padding-top:40px;display:grid;grid-template-columns:1.1fr .9fr;gap:48px;align-items:center">
 <div><p class="sans" style="text-transform:uppercase;letter-spacing:.16em;font-size:12px;color:${COFFEE.accent};margin:0 0 18px">Small-batch coffee, every month</p>
 <h1 style="font-size:68px;margin-bottom:22px">Roasted this week.<br>On your doorstep.</h1>
 <p style="font-size:19px;max-width:30em;margin:0 0 28px">We roast on Mondays and ship on Tuesdays, so every bag reaches you inside nine days of the roaster — not nine weeks.</p>
 <a class="btn" href="pricing.html" data-dc-goto="pricing">See the plans</a> &nbsp; <a class="btn ghost" href="#">How it works</a></div>
 <div style="aspect-ratio:1;border-radius:200px 200px 24px 24px;background:linear-gradient(160deg,${COFFEE.accent},#6b2d12);display:grid;place-items:center;color:${COFFEE.card};font-size:96px">☕</div>
</section>
<section><div class="grid">
 <div class="card"><h3>Single origin</h3><p>One farm, one harvest, one story on the bag.</p></div>
 <div class="card"><h3>Roast to order</h3><p>Nothing sits on a shelf. Your bag is roasted after you pay.</p></div>
 <div class="card"><h3>Skip any month</h3><p>Pause, swap or cancel from one page — no emails.</p></div>
</div></section>`,
    `@media (max-width:640px){section:nth-of-type(1){grid-template-columns:1fr!important;padding-top:16px!important}}`,
  );

export const coffeePricing = (): string =>
  base(
    COFFEE,
    'Ember & Oak — Plans',
    `${nav('Ember &amp; Oak', 'pricing')}
<section style="text-align:center;padding-bottom:16px"><h1 style="font-size:54px">Pick a rhythm</h1><p style="font-size:18px">Same beans, different cadence. Change it any time.</p></section>
<section><div class="grid">
 <div class="card"><p class="sans" style="margin:0;color:${COFFEE.accent};font-weight:600">Weekend</p><h2 style="font-size:44px;margin:10px 0">$14<small class="sans" style="font-size:15px;font-weight:400"> / month</small></h2><p>One 250 g bag, roasted fresh.</p><a class="btn ghost" href="checkout.html">Choose Weekend</a></div>
 <div class="card" style="background:${COFFEE.ink};color:${COFFEE.card}"><p class="sans" style="margin:0;color:#f0a77f;font-weight:600">Everyday · most picked</p><h2 style="font-size:44px;margin:10px 0">$26<small class="sans" style="font-size:15px;font-weight:400"> / month</small></h2><p>Two 250 g bags, two origins.</p><a class="btn" href="checkout.html">Choose Everyday</a></div>
 <div class="card"><p class="sans" style="margin:0;color:${COFFEE.accent};font-weight:600">Office</p><h2 style="font-size:44px;margin:10px 0">$68<small class="sans" style="font-size:15px;font-weight:400"> / month</small></h2><p>Four 500 g bags, whole bean.</p><a class="btn ghost" href="checkout.html">Choose Office</a></div>
</div></section>`,
  );

export const coffeeCheckout = (): string =>
  base(
    COFFEE,
    'Ember & Oak — Checkout',
    `${nav('Ember &amp; Oak', 'checkout')}
<section style="max-width:620px;margin:0 auto"><h1 style="font-size:46px;margin-bottom:24px">Almost there</h1>
<form class="card sans" onsubmit="return false" style="display:grid;gap:14px">
 <label>Email<br><input style="width:100%;padding:12px;border-radius:10px;border:1px solid ${COFFEE.soft};font:inherit" placeholder="you@example.com"></label>
 <label>Delivery address<br><input style="width:100%;padding:12px;border-radius:10px;border:1px solid ${COFFEE.soft};font:inherit" placeholder="Street, city"></label>
 <label>Grind<br><select style="width:100%;padding:12px;border-radius:10px;border:1px solid ${COFFEE.soft};font:inherit"><option>Whole bean</option><option>Filter</option><option>Espresso</option></select></label>
 <button class="btn" type="button">Start my subscription — $26 / month</button>
</form></section>`,
  );

export const pricingArtifact = (): string =>
  base(
    SLATE,
    'Northwind pricing',
    `<main style="max-width:960px;margin:0 auto;padding:72px 28px;font-family:'Segoe UI',system-ui,sans-serif">
<p style="color:${SLATE.accent};font-weight:600;margin:0 0 10px">Pricing</p>
<h1 style="font-family:'Segoe UI',system-ui,sans-serif;font-size:48px;margin-bottom:12px">Simple plans for growing teams</h1>
<p style="font-size:18px;color:#4a5568;max-width:36em">Start free. Upgrade when your team outgrows the basics — no per-seat surprises.</p>
<div class="grid" style="margin-top:40px">
 <div class="card"><h3>Starter</h3><p style="font-size:36px;font-weight:700;margin:12px 0">Free</p><p>Up to 3 projects</p><a class="btn ghost" href="#">Start free</a></div>
 <div class="card" style="border:2px solid ${SLATE.accent}"><h3>Team</h3><p style="font-size:36px;font-weight:700;margin:12px 0">$24</p><p>Unlimited projects, SSO</p><a class="btn" href="#">Try Team</a></div>
 <div class="card"><h3>Scale</h3><p style="font-size:36px;font-weight:700;margin:12px 0">Talk to us</p><p>Audit log, SLA</p><a class="btn ghost" href="#">Contact sales</a></div>
</div></main>`,
  );

export const invoiceArtifact = (): string =>
  base(
    SAGE,
    'Invoice template',
    `<main style="max-width:760px;margin:40px auto;background:${SAGE.card};padding:56px;border-radius:6px;border:1px solid ${SAGE.soft};font-family:'Segoe UI',system-ui,sans-serif">
<div style="display:flex;justify-content:space-between"><h1 style="font-family:Georgia,serif;font-size:40px">Invoice</h1><div style="text-align:right;font-size:14px">No. 2026-014<br>26 October 2026</div></div>
<hr style="border:0;border-top:2px solid ${SAGE.ink};margin:28px 0">
<table style="width:100%;border-collapse:collapse;font-size:15px"><tr style="text-align:left;color:#5b6b5d"><th style="padding:8px 0">Description</th><th>Qty</th><th style="text-align:right">Amount</th></tr>
<tr><td style="padding:12px 0;border-top:1px solid ${SAGE.soft}">Design sprint, week 1</td><td>1</td><td style="text-align:right">$4,800.00</td></tr>
<tr><td style="padding:12px 0;border-top:1px solid ${SAGE.soft}">Prototype handoff</td><td>1</td><td style="text-align:right">$1,200.00</td></tr></table>
<p style="text-align:right;font-size:22px;font-weight:700;margin-top:28px">Total $6,000.00</p></main>`,
  );

export const onboardingScreen = (title: string, step: string): string =>
  base(
    SLATE,
    title,
    `<main style="min-height:100vh;display:grid;place-items:center;padding:40px;font-family:'Segoe UI',system-ui,sans-serif"><div class="card" style="max-width:420px;width:100%;text-align:center"><p style="color:${SLATE.accent};font-weight:600;margin:0">${step}</p><h1 style="font-family:'Segoe UI',system-ui,sans-serif;font-size:30px;margin:10px 0 18px">${title}</h1><a class="btn" href="#">Continue</a></div></main>`,
  );
