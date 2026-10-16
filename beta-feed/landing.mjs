function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}

export function renderLandingPage({version, installLink}) {
  const download = installLink
    ? `<a class="download" href="${escapeHtml(installLink)}">Download Agent Time for Mac</a><p class="link-note">Private invite for ${escapeHtml(version)}. This link expires; ask for a new one if it stops working.</p>`
    : `<div class="invite-note"><strong>Closed beta</strong><span>Ask your inviter for a private installation link.</span></div>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#edf1f8">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <meta name="description" content="A private Apple Silicon beta for reviewing Mac and AI agent work in one local timeline.">
  <meta property="og:title" content="Agent Time — private beta for Mac">
  <meta property="og:description" content="Review your Mac and AI agent work in one local timeline.">
  <meta property="og:image" content="https://agent-time.ezyostudio.com/icon.png">
  <link rel="icon" type="image/png" href="/icon.png">
  <title>Agent Time — closed beta</title>
  <style>
    @font-face { font-family: Manrope; src: url('/manrope.ttf') format('truetype'); font-style: normal; font-weight: 200 800; font-display: swap; }
    :root { font-family: Manrope, sans-serif; color: #17253d; background: #edf1f8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    a { color: inherit; }
    a:focus-visible { outline: 3px solid #4668b2; outline-offset: 4px; }
    .skip { position: absolute; left: 24px; top: -80px; z-index: 5; padding: 8px 12px; border-radius: 8px; background: #fff; color: #17253d; }
    .skip:focus { top: 12px; }
    .shell { max-width: 1160px; margin: 0 auto; padding: 32px 48px 48px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
    .brand { display: flex; align-items: center; gap: 12px; font-size: 18px; font-weight: 710; letter-spacing: -.03em; }
    .brand img { width: 36px; height: 36px; border-radius: 9px; }
    .status { color: #526682; font-size: 14px; }
    .hero { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, .84fr); align-items: center; gap: clamp(30px, 7vw, 110px); padding: 118px 0 116px; }
    h1 { max-width: 680px; margin: 0; padding-bottom: 8px; font-size: clamp(48px, 6vw, 72px); font-weight: 700; line-height: 1.05; letter-spacing: -.065em; text-wrap: balance; background: linear-gradient(90deg, #000, #666); background-clip: text; -webkit-text-fill-color: transparent; }
    .lead { max-width: 540px; margin: 32px 0 0; color: #465b76; font-size: 20px; line-height: 28px; letter-spacing: -.015em; text-wrap: pretty; }
    .actions { margin-top: 38px; }
    .download { display: inline-flex; align-items: center; min-height: 48px; padding: 8px 12px; background: #315aa7; color: white; border-radius: 8px; text-decoration: none; font-size: 16px; line-height: 24px; font-weight: 600; box-shadow: 0 12px 30px #315aa724; }
    .download:hover { background: #254d98; }
    .download:active { transform: translateY(1px); }
    .proof { display: flex; align-items: center; gap: 8px; margin: 16px 0 0; color: #526682; font-size: 14px; line-height: 20px; text-wrap: pretty; }
    .proof::before { content: "✓"; display: inline-grid; place-items: center; width: 18px; height: 18px; flex: none; border-radius: 50%; background: #dce8df; color: #27633f; font-weight: 700; }
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
    .details { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 32px; padding: 40px 0 64px; border-top: 1px solid #cbd5e5; }
    .details h2 { margin: 0 0 12px; font-size: 18px; letter-spacing: -.03em; }
    .details p { margin: 0; color: #536781; font-size: 14px; line-height: 1.6; }
    .questions { max-width: 680px; padding: 0 0 64px; }
    .questions h2 { margin: 0 0 24px; font-size: 30px; line-height: 36px; letter-spacing: -.04em; text-wrap: balance; }
    .questions details { border-top: 1px solid #cbd5e5; padding: 16px 0; }
    .questions details:last-child { border-bottom: 1px solid #cbd5e5; }
    .questions summary { cursor: pointer; font-size: 16px; line-height: 24px; font-weight: 600; }
    .questions details p { margin: 12px 24px 0 0; color: #536781; font-size: 14px; line-height: 20px; text-wrap: pretty; }
    footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; padding-top: 22px; border-top: 1px solid #cbd5e5; color: #61738d; font-size: 13px; }
    footer a { color: #315aa7; text-underline-offset: 3px; }
    @media (max-width: 800px) { .shell { padding: 24px 24px 36px; } .hero { grid-template-columns: minmax(0, 1fr); padding: 80px 0 64px; gap: 64px; } .hero > div { min-width: 0; } .preview { width: 100%; max-width: 540px; min-height: 320px; } .details { grid-template-columns: minmax(0, 1fr); gap: 24px; } }
    @media (max-width: 460px) { .shell { padding-inline: 16px; } .status { display: none; } .hero { padding-top: 64px; } h1 { font-size: 48px; } .preview { transform: none; } .preview::after { display: none; } }
    @media (prefers-reduced-motion: no-preference) { .download { transition: background 700ms cubic-bezier(.32,.72,0,1), transform 700ms cubic-bezier(.32,.72,0,1); } .download:hover { transform: translateY(-2px); } }
  </style>
</head>
<body>
  <a class="skip" href="#content">Skip to content</a>
  <div class="shell">
    <header><div class="brand"><img src="/icon.png" alt="">Agent Time</div><div class="status">Apple Silicon beta</div></header>
    <main id="content">
      <section class="hero" aria-labelledby="hero-title">
        <div><h1 id="hero-title">See where your work time goes.</h1><p class="lead">For people who work with AI agents on a Mac. Agent Time puts your activity and your agents’ work in one local timeline.</p><div class="actions">${download}<p class="proof">Developer ID signed and notarized for macOS</p></div></div>
        <div class="preview" aria-label="Illustration of an activity timeline"><div class="preview-head"><span>Today’s activity</span><span>Local to your Mac</span></div><div class="scale"><span>9:00</span><span>11:00</span><span>13:00</span><span>15:00</span></div><div class="track" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div><div class="preview-rows"><div class="preview-row"><i class="swatch"></i>Mac activity<span>Example timeline</span></div><div class="preview-row"><i class="swatch alt"></i>Agent activity<span>Example timeline</span></div></div></div>
      </section>
      <section class="details" aria-label="Before you install"><div><h2>Install once</h2><p>Open the DMG in Finder, drag Agent Time to Applications, then open it from there. Do not bypass a macOS security warning; tell us if one appears.</p></div><div><h2>Choose what to track</h2><p>Turn on the sources you want in Settings. Browser tracking may store full page URLs and titles locally. Accessibility is optional.</p></div><div><h2>Updates in the app</h2><p>In app updates are being tested. Your inviter will tell you when they are ready.</p></div></section>
      <section class="questions" aria-labelledby="questions-title"><h2 id="questions-title">Before you try the beta</h2><details><summary>Does my activity leave my Mac?</summary><p>Agent Time stores captured activity locally. It does not automatically upload your capture history or diagnostics.</p></details><details><summary>Can I choose which sources are tracked?</summary><p>Yes. You choose Mac activity, agents, and individual browsers in Settings. Accessibility permission is optional.</p></details><details><summary>What if the installer does not open?</summary><p>Do not bypass a macOS security warning. Email the beta support address below with your macOS version and what you saw.</p></details></section>
    </main>
    <footer><span>Closed beta for Apple Silicon Macs. macOS 13.5 or later is being verified. <a href="https://github.com/zaosoula/agent-time/blob/main/docs/beta/privacy.md">Beta data notice</a></span><span>Questions or install problems? <a href="mailto:zao.soula@ezyostudio.com">zao.soula@ezyostudio.com</a></span></footer>
  </div>
</body>
</html>`;
}
