function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}

export function renderLandingPage({version, installLink}) {
  const download = installLink
    ? `<a class="download" href="${escapeHtml(installLink)}">Download Agent Time for Mac <span aria-hidden="true">↘</span></a><p class="link-note">Private invite for ${escapeHtml(version)}. This link expires; ask for a new one if it stops working.</p>`
    : `<div class="invite-note"><strong>Closed beta</strong><span>Ask your inviter for a private installation link.</span></div>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#edf1f8">
  <title>Agent Time — closed beta</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; color: #17253d; background: #edf1f8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    a { color: inherit; }
    a:focus-visible { outline: 3px solid #4668b2; outline-offset: 4px; }
    .shell { max-width: 1160px; margin: 0 auto; padding: 32px 48px 48px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
    .brand { display: flex; align-items: center; gap: 12px; font-size: 18px; font-weight: 710; letter-spacing: -.03em; }
    .brand img { width: 36px; height: 36px; border-radius: 9px; }
    .status { color: #526682; font-size: 14px; }
    .hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, .84fr); align-items: center; gap: clamp(30px, 7vw, 110px); padding: 118px 0 116px; }
    h1 { max-width: 690px; margin: 0; font-size: clamp(48px, 6.5vw, 84px); font-weight: 690; line-height: .99; letter-spacing: -.075em; }
    .lead { max-width: 540px; margin: 31px 0 0; color: #465b76; font-size: clamp(18px, 1.7vw, 21px); line-height: 1.55; letter-spacing: -.015em; }
    .actions { margin-top: 38px; }
    .download { display: inline-flex; align-items: center; gap: 28px; min-height: 56px; padding: 0 20px; background: #315aa7; color: white; border-radius: 12px; text-decoration: none; font-weight: 650; box-shadow: 0 12px 30px #315aa724; }
    .download:hover { background: #254d98; }
    .download span { font-size: 22px; line-height: 1; }
    .link-note { max-width: 370px; margin: 12px 0 0; color: #5c6d84; font-size: 13px; line-height: 1.5; }
    .invite-note { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 8px 14px; padding: 18px 20px; border: 1px solid #cbd5e7; border-radius: 12px; color: #4b5f7e; font-size: 14px; }
    .invite-note strong { color: #315aa7; }
    .preview { position: relative; min-height: 350px; padding: 29px 28px; border: 1px solid #d6dfec; border-radius: 24px; background: #fff; box-shadow: 0 28px 70px #29406415; transform: rotate(-2deg); }
    .preview::after { content: ""; position: absolute; z-index: -1; inset: 18px -16px -18px 16px; border: 1px solid #c7d4e9; border-radius: 24px; background: #dde7f6; }
    .preview-head { display: flex; justify-content: space-between; color: #233b62; font-size: 14px; font-weight: 640; }
    .preview-head span:last-child { color: #7788a1; font-size: 12px; font-weight: 500; }
    .scale { display: flex; justify-content: space-between; margin: 48px 0 15px; color: #8493a9; font-size: 11px; }
    .track { display: grid; grid-template-columns: 25% 6% 36% 5% 28%; height: 42px; overflow: hidden; border-radius: 9px; background: #edf2fa; }
    .track span:nth-child(1) { background: #6486ca; } .track span:nth-child(3) { background: #a5b9df; } .track span:nth-child(5) { background: #779bd2; }
    .preview-rows { margin-top: 26px; border-top: 1px solid #e4eaf3; }
    .preview-row { display: flex; align-items: center; gap: 10px; padding: 13px 0; border-bottom: 1px solid #eef1f7; color: #60718c; font-size: 12px; }
    .swatch { width: 9px; height: 9px; border-radius: 3px; background: #6486ca; } .swatch.alt { background: #a5b9df; }
    .preview-row span:last-child { margin-left: auto; color: #98a6ba; }
    .details { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 34px; padding: 37px 0 64px; border-top: 1px solid #cbd5e5; }
    .details h2 { margin: 0 0 12px; font-size: 18px; letter-spacing: -.03em; }
    .details p { margin: 0; color: #536781; font-size: 14px; line-height: 1.6; }
    footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; padding-top: 22px; border-top: 1px solid #cbd5e5; color: #61738d; font-size: 13px; }
    footer a { color: #315aa7; text-underline-offset: 3px; }
    @media (max-width: 800px) { .shell { padding: 22px 24px 36px; } .hero { grid-template-columns: 1fr; padding: 85px 0 65px; gap: 64px; } .preview { max-width: 540px; min-height: 320px; } .details { grid-template-columns: 1fr; gap: 26px; } }
    @media (max-width: 460px) { .shell { padding-inline: 19px; } .status { font-size: 12px; } .hero { padding-top: 72px; } h1 { font-size: 50px; } .preview { transform: none; } .preview::after { display: none; } }
    @media (prefers-reduced-motion: no-preference) { .download { transition: background .16s ease, transform .16s ease; } .download:hover { transform: translateY(-2px); } }
  </style>
</head>
<body>
  <div class="shell">
    <header><div class="brand"><img src="/icon.png" alt="">Agent Time</div><div class="status">Apple Silicon beta</div></header>
    <main>
      <section class="hero" aria-labelledby="hero-title">
        <div><h1 id="hero-title">See where your work time goes.</h1><p class="lead">Agent Time brings your Mac and agent activity into one local timeline, so you can review what happened and spot gaps in tracking.</p><div class="actions">${download}</div></div>
        <div class="preview" aria-label="Illustration of an activity timeline"><div class="preview-head"><span>Today’s activity</span><span>Local to your Mac</span></div><div class="scale"><span>9:00</span><span>11:00</span><span>13:00</span><span>15:00</span></div><div class="track" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div><div class="preview-rows"><div class="preview-row"><i class="swatch"></i>Mac activity<span>Example timeline</span></div><div class="preview-row"><i class="swatch alt"></i>Agent activity<span>Example timeline</span></div></div></div>
      </section>
      <section class="details" aria-label="Before you install"><div><h2>Install once</h2><p>Open the DMG in Finder, drag Agent Time to Applications, then open it from there. Do not bypass a macOS security warning; tell us if one appears.</p></div><div><h2>Choose what to track</h2><p>Turn on the sources you want in Settings. Browser tracking may store full page URLs and titles locally. Accessibility is optional.</p></div><div><h2>Updates in the app</h2><p>Later beta releases arrive through Agent Time. You choose when to install an update and restart capture.</p></div></section>
    </main>
    <footer><span>Closed beta for Apple Silicon Macs. macOS 13.5 or later is being verified.</span><span>Questions or install problems? <a href="mailto:zao.soula@ezyostudio.com">zao.soula@ezyostudio.com</a></span></footer>
  </div>
</body>
</html>`;
}
