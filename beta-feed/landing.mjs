function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}

export function renderLandingPage({version, installLink}) {
  const download = installLink
    ? `<a class="download" href="${escapeHtml(installLink)}">Download Agent Time for Mac <span aria-hidden="true">↗</span></a><p class="link-note">Version ${escapeHtml(version)} for Apple Silicon Macs.</p>`
    : '<div class="availability-note"><span class="dot" aria-hidden="true"></span><strong>Public beta</strong><span>The installer is being prepared.</span></div>';
  const finalDownload = installLink
    ? `<a class="download" href="${escapeHtml(installLink)}">Download Agent Time for Mac <span aria-hidden="true">↗</span></a>`
    : '<p class="final-note">The installer is being prepared.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#131209">
  <meta name="description" content="Agent Time is an open source Apple Silicon app for reviewing Mac and AI agent work in one local timeline.">
  <meta property="og:title" content="Agent Time — public beta for Mac">
  <meta property="og:description" content="See your Mac activity and your agents’ work in one local timeline.">
  <meta property="og:image" content="https://agent-time.ezyostudio.com/icon.png">
  <meta property="og:url" content="https://agent-time.ezyostudio.com/">
  <link rel="canonical" href="https://agent-time.ezyostudio.com/">
  <link rel="icon" type="image/png" href="/icon.png">
  <title>Agent Time — open source time tracking for Mac and AI agents</title>
  <style>
    @font-face { font-family: Manrope; src: url('/manrope.ttf') format('truetype'); font-style: normal; font-weight: 200 800; font-display: swap; }
    :root { font-family: Manrope, sans-serif; color: #f5f5f3; background: #131209; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; min-width: 320px; }
    a { color: inherit; }
    a:focus-visible, summary:focus-visible { outline: 3px solid #c5e476; outline-offset: 4px; }
    .skip { position: absolute; top: -80px; left: 24px; z-index: 10; padding: 8px 12px; border-radius: 8px; background: white; color: #131209; }
    .skip:focus { top: 12px; }
    .shell { width: min(100% - 48px, 1120px); margin: 0 auto; }
    header { position: relative; z-index: 2; border-bottom: 1px solid #29291f; }
    .header-inner { min-height: 72px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
    .brand { display: inline-flex; align-items: center; gap: 12px; font-size: 16px; font-weight: 700; letter-spacing: -.03em; }
    .brand img { width: 32px; height: 32px; border-radius: 8px; background: white; }
    .header-label { color: #a2a399; font-size: 14px; }
    .hero { position: relative; overflow: hidden; isolation: isolate; text-align: center; padding: 104px 0 0; }
    .hero::before { content: ""; position: absolute; z-index: -2; inset: 0 0 115px; background-image: linear-gradient(#29311a 1px, transparent 1px), linear-gradient(90deg, #29311a 1px, transparent 1px); background-size: 24px 24px; opacity: .38; }
    .hero::after { content: ""; position: absolute; z-index: -1; inset: 0 0 105px; background: radial-gradient(ellipse at center, transparent 10%, #131209 74%); }
    .eyebrow { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid #383a30; border-radius: 999px; background: #24251f; color: #dfdfd9; font-size: 12px; line-height: 16px; font-weight: 600; }
    .eyebrow::before, .dot { content: ""; width: 7px; height: 7px; flex: none; border-radius: 50%; background: #c5e476; box-shadow: 0 0 0 3px #c5e47622; }
    h1 { max-width: 680px; margin: 32px auto 0; font-size: clamp(48px, 5vw, 72px); line-height: 1; letter-spacing: -.065em; font-weight: 700; text-wrap: balance; }
    h1 span { color: #a5a5a0; }
    .lead { max-width: 610px; margin: 24px auto 0; color: #adafa8; font-size: 18px; line-height: 28px; text-wrap: pretty; }
    .actions { display: flex; align-items: center; flex-direction: column; margin-top: 32px; }
    .download { display: inline-flex; align-items: center; justify-content: center; gap: 16px; min-height: 48px; padding: 8px 12px; border-radius: 8px; background: #f4f4ef; color: #131209; font-size: 16px; line-height: 24px; font-weight: 700; text-decoration: none; }
    .download:hover { background: #dceabb; transform: translateY(-2px); }
    .download:active { transform: translateY(1px); }
    .download span { font-size: 18px; font-weight: 400; }
    .availability-note { display: inline-flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border: 1px solid #3a3b31; border-radius: 8px; background: #24251f; color: #afb0a8; font-size: 14px; line-height: 24px; }
    .availability-note strong { color: #f5f5f3; }
    .link-note { max-width: 440px; margin: 12px auto 0; color: #96988f; font-size: 12px; line-height: 16px; text-wrap: pretty; }
    .proof { display: flex; justify-content: center; align-items: center; gap: 8px; margin: 16px auto 0; color: #a4a69d; font-size: 14px; line-height: 20px; }
    .proof::before { content: "✓"; display: inline-grid; place-items: center; width: 18px; height: 18px; flex: none; border-radius: 50%; background: #34452d; color: #c5e476; font-weight: 700; }
    .preview { position: relative; width: min(100%, 840px); margin: 80px auto 0; padding: 8px; border: 1px solid #35362f; border-radius: 16px; background: #20211d; box-shadow: 0 32px 80px #0008; text-align: left; }
    .preview-inner { min-height: 300px; overflow: hidden; border: 1px solid #31332c; border-radius: 10px; background: #181916; }
    .preview-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 48px; padding: 0 24px; border-bottom: 1px solid #30312b; color: #e2e2dc; font-size: 12px; }
    .preview-top span:last-child { color: #989b90; }
    .preview-body { padding: 32px 40px 40px; }
    .preview-caption { display: flex; justify-content: space-between; gap: 12px; color: #d7d9d0; font-size: 14px; font-weight: 600; }
    .preview-caption span:last-child { color: #92958a; font-size: 12px; font-weight: 400; }
    .scale { display: flex; justify-content: space-between; margin: 40px 0 12px; color: #878b80; font-size: 12px; }
    .track { display: grid; grid-template-columns: 25% 6% 36% 5% 28%; height: 48px; overflow: hidden; border-radius: 8px; background: #292c26; }
    .track span:nth-child(1) { background: #a9c778; } .track span:nth-child(3) { background: #607e9d; } .track span:nth-child(5) { background: #a9c778; }
    .preview-rows { margin-top: 24px; border-top: 1px solid #30312b; }
    .preview-row { display: flex; align-items: center; gap: 12px; min-height: 40px; border-bottom: 1px solid #30312b; color: #b8bcb0; font-size: 12px; }
    .swatch { width: 8px; height: 8px; border-radius: 2px; background: #a9c778; } .swatch.alt { background: #607e9d; }
    .preview-row span:last-child { margin-left: auto; color: #858a80; }
    .section { border-top: 1px solid #2d2e27; padding: 80px 0; }
    .section-label { margin: 0 0 16px; color: #c5e476; font-size: 12px; line-height: 16px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .section h2 { max-width: 680px; margin: 0; font-size: clamp(30px, 3vw, 48px); line-height: 1.15; letter-spacing: -.05em; text-wrap: balance; }
    .section-intro { max-width: 610px; margin: 16px 0 0; color: #a7a99f; font-size: 16px; line-height: 24px; text-wrap: pretty; }
    .benefits { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 40px; }
    .benefit { padding: 24px; border: 1px solid #34362e; border-radius: 12px; background: #1f211c; }
    .benefit-number { color: #c5e476; font-size: 12px; line-height: 16px; }
    .benefit h3 { margin: 24px 0 12px; font-size: 18px; line-height: 28px; letter-spacing: -.03em; }
    .benefit p { margin: 0; color: #a5a99e; font-size: 14px; line-height: 20px; text-wrap: pretty; }
    .install { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 64px; align-items: start; }
    .steps { display: grid; gap: 24px; margin: 0; padding: 0; list-style: none; }
    .steps li { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 16px; }
    .step-number { display: grid; place-items: center; width: 32px; height: 32px; border: 1px solid #414938; border-radius: 8px; color: #c5e476; font-size: 14px; }
    .steps strong { display: block; margin: 0 0 4px; font-size: 16px; line-height: 24px; }
    .steps p { margin: 0; color: #a5a99e; font-size: 14px; line-height: 20px; text-wrap: pretty; }
    .questions { max-width: 760px; }
    .questions-list { margin-top: 40px; }
    .questions details { border-top: 1px solid #35372f; padding: 20px 0; }
    .questions details:last-child { border-bottom: 1px solid #35372f; }
    .questions summary { cursor: pointer; font-size: 16px; line-height: 24px; font-weight: 600; }
    .questions details p { margin: 12px 0 0; color: #a5a99e; font-size: 14px; line-height: 20px; text-wrap: pretty; }
    .final { text-align: center; }
    .final h2 { margin-inline: auto; }
    .final .section-intro { margin-inline: auto; }
    .final .download, .final-note { margin-top: 32px; }
    .final-note { color: #a5a99e; font-size: 14px; }
    footer { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; padding: 32px 0 48px; border-top: 1px solid #2d2e27; color: #96998e; font-size: 12px; line-height: 20px; }
    footer a { color: #d9dfc9; text-underline-offset: 3px; }
    @media (max-width: 760px) { .hero { padding-top: 80px; } .hero::before, .hero::after { bottom: 80px; } .preview { margin-top: 64px; } .preview-body { padding: 24px; } .benefits { grid-template-columns: minmax(0, 1fr); } .install { grid-template-columns: minmax(0, 1fr); gap: 40px; } .section { padding: 64px 0; } }
    @media (max-width: 460px) { .shell { width: min(100% - 32px, 1120px); } .header-label { display: none; } .hero { padding-top: 64px; } h1 { font-size: 36px; line-height: 40px; } .lead { font-size: 16px; line-height: 24px; } .preview { margin-top: 48px; } .preview-body { padding: 16px; } .preview-top { padding-inline: 16px; } .preview-top span:last-child, .preview-caption span:last-child { display: none; } .section { padding: 48px 0; } .benefit { padding: 16px; } }
    @media (prefers-reduced-motion: no-preference) { .download { transition: background 700ms cubic-bezier(.32,.72,0,1), transform 700ms cubic-bezier(.32,.72,0,1); } }
  </style>
</head>
<body>
  <a class="skip" href="#content">Skip to content</a>
  <header><div class="shell header-inner"><div class="brand"><img src="/icon.png" alt="">Agent Time</div><div class="header-label">Public beta for Apple Silicon</div></div></header>
  <main id="content">
    <section class="hero" aria-labelledby="hero-title"><div class="shell">
      <div class="eyebrow">Mac activity and AI agents, together</div>
      <h1 id="hero-title">See your work time.<br><span>Agents included.</span></h1>
      <p class="lead">Agent Time puts your Mac activity and your agents’ work in one local timeline, so you can review the whole day in context.</p>
      <div class="actions">${download}<p class="proof">Developer ID signed and notarized for macOS</p></div>
      <div class="preview" role="img" aria-label="Illustration of an activity timeline showing Mac activity and agent activity"><div class="preview-inner"><div class="preview-top"><span>Agent Time</span><span>Example timeline</span></div><div class="preview-body"><div class="preview-caption"><span>Today’s activity</span><span>Local to your Mac</span></div><div class="scale"><span>9:00</span><span>11:00</span><span>13:00</span><span>15:00</span></div><div class="track" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div><div class="preview-rows"><div class="preview-row"><i class="swatch"></i>Mac activity<span>Example timeline</span></div><div class="preview-row"><i class="swatch alt"></i>Agent activity<span>Example timeline</span></div></div></div></div></div>
    </div></section>
    <section class="section" aria-labelledby="benefits-title"><div class="shell"><p class="section-label">One view of the day</p><h2 id="benefits-title">Your work has more than one clock.</h2><p class="section-intro">Review what happened on your Mac alongside the work your agents carried out.</p><div class="benefits"><article class="benefit"><span class="benefit-number">01 / Mac</span><h3>See active time</h3><p>Review foreground app activity and idle periods in the timeline.</p></article><article class="benefit"><span class="benefit-number">02 / Agents</span><h3>Follow agent work</h3><p>Keep agent sessions and tool activity in view while you work elsewhere.</p></article><article class="benefit"><span class="benefit-number">03 / Control</span><h3>Choose your sources</h3><p>Turn individual sources on in Settings. Captured history stays on your Mac.</p></article></div></div></section>
    <section class="section" aria-labelledby="install-title"><div class="shell install"><div><p class="section-label">Getting started</p><h2 id="install-title">Install it once. Make the timeline yours.</h2><p class="section-intro">This beta is for Apple Silicon Macs. In app updates are still being tested; the app will offer them when they are ready.</p></div><ol class="steps"><li><span class="step-number">1</span><div><strong>Open the DMG</strong><p>Drag Agent Time to Applications, then open it from there. Tell us if macOS shows a security warning.</p></div></li><li><span class="step-number">2</span><div><strong>Choose what to track</strong><p>Enable the Mac, agent, and browser sources you want in Settings. Accessibility permission is optional.</p></div></li><li><span class="step-number">3</span><div><strong>Review your day</strong><p>Explore the local timeline. Browser tracking may store full page URLs and titles on your Mac.</p></div></li></ol></div></section>
    <section class="section" aria-labelledby="questions-title"><div class="shell questions"><p class="section-label">Good to know</p><h2 id="questions-title">Before you try the beta</h2><div class="questions-list"><details><summary>Does my activity leave my Mac?</summary><p>Agent Time stores captured activity locally. It does not automatically upload your capture history or diagnostics.</p></details><details><summary>Can I choose which sources are tracked?</summary><p>Yes. You choose Mac activity, agents, and individual browsers in Settings. Accessibility permission is optional.</p></details><details><summary>What if the installer does not open?</summary><p>Do not bypass a macOS security warning. Email the beta support address below with your macOS version and what you saw.</p></details></div></div></section>
    <section class="section final" aria-labelledby="final-title"><div class="shell"><p class="section-label">Open source public beta</p><h2 id="final-title">See the full shape of your work.</h2><p class="section-intro">One local timeline for your Mac activity and your agents’ work.</p>${finalDownload}</div></section>
  </main>
  <footer class="shell"><span>Public beta for Apple Silicon Macs. macOS 13.5 or later is being verified. <a href="https://github.com/zaosoula/agent-time/blob/main/docs/beta/privacy.md">Beta data notice</a> · <a href="https://github.com/zaosoula/agent-time">Source code</a> · <a href="https://github.com/zaosoula/agent-time/blob/main/LICENSE">MIT license</a></span><span>Questions or install problems? <a href="mailto:zao.soula@ezyostudio.com">zao.soula@ezyostudio.com</a></span></footer>
</body>
</html>`;
}
