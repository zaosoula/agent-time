import {DOC_PAGES} from './docs-content.mjs';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}

// Each word becomes its own span so the reveal can light words in reading order.
function revealWords(lines) {
  let index = 0;
  return lines.map(line => line.split(' ').map(word => `<span style="--i:${index++}">${escapeHtml(word)}</span>`).join(' ')).join('<br>');
}

const SOURCES = [
  {group: 'Agents', name: 'Claude Code', detail: 'Hooks record native sessions, tool activity and subagents, including background launches outside Orca. Local usage import is optional.'},
  {group: 'Agents', name: 'Codex', detail: 'Native sessions and subagents join the same timeline after hook setup and the normal Codex trust review.'},
  {group: 'Agents', name: 'Orca', detail: 'Worker polling every five seconds, Run and Dispatch identities, and the selected tab for human time.'},
  {group: 'Browsers', name: 'Safari', detail: 'Domain, page URL and title through Accessibility. URL credentials are removed before storage.'},
  {group: 'Browsers', name: 'Chrome', detail: 'Independent switch. Saved origin or URL prefix rules attach page time to a project.'},
  {group: 'Browsers', name: 'Brave', detail: 'Independent switch. Localhost ports can match the project that is listening on them.'},
  {group: 'Context', name: 'macOS activity', detail: 'Foreground app and idle time below your threshold. Five minutes by default.'},
  {group: 'Context', name: 'Local Git', detail: 'Local commits add evidence beside recorded project time. A commit alone does not establish a duration.'},
  {group: 'Context', name: 'Linear', detail: 'Read only project names and links, used as suggestions for website matching.'},
];

const QUESTIONS = [
  ['Does my activity leave my Mac?', 'Captured activity is stored in a local SQLite database and is not automatically uploaded. Updates, the public pricing catalog and integrations you connect can make network requests. Connected MCP clients receive the tool results they request and apply their own privacy settings. You choose when to export or share a report.'],
  ['Does it store prompts or keystrokes?', 'Automatic hooks drop prompt and tool output bodies, and Agent Time does not store keystroke contents. Notes, task descriptions and context you or your agents explicitly report are stored locally. Enabled browser capture can store full URLs and page titles.'],
  ['What can my agents see through MCP?', 'Captured time, sessions, attribution, coverage and saved billing estimates through a local stdio server. Browser URLs, page titles and terminal titles are omitted from time replies. Project and billing queries support full months; detailed evidence tools have bounded ranges and disclose truncation.'],
  ['Do I need Orca?', 'No. Claude Code and Codex hooks also capture native sessions launched from a terminal or a background launcher. Orca adds workspace, worker and dispatch context when available.'],
  ['How is agent time counted?', 'Cumulative agent time adds each native execution, including subagents. Agent wall time counts parallel agents once. The shared clock counts periods with human or agent activity once. These are elapsed activity measurements, not CPU usage or productivity scores.'],
  ['What happens during missing capture?', 'Gaps and missing permissions are disclosed. Billing excludes known capture pauses, sleep, lock events and long gaps in Mac observations. Unknown time is not certified as inactivity. Check the time guide before comparing measured summaries with billing totals.'],
  ['Can I prepare billing reports?', 'Yes. Group repositories into a project, choose rates, activity counting and final rounding, then save a report or export CSV and Markdown. Reports preserve the rules used to calculate them. You review coverage and attribution before using a report; Agent Time does not issue invoices.'],
  ['Which Macs are supported?', 'Apple Silicon Macs running macOS 13.5 or later. The desktop widget requires macOS 14 or later.'],
  ['Can I remove the hooks later?', 'Yes. Settings → Data & backup includes tracking cleanup, and Settings → Agents manages MCP connections per account. Agent Time previews its own entries and preserves entries installed by other tools. Removing the app alone does not erase local history or installed hooks.'],
  ['Is it open source?', 'Yes, under the MIT license. Each tracked source is one file, so adding a browser or agent with the same capture shape is a small change.'],
];

export function renderLandingPage({version, installLink}) {
  const download = installLink
    ? `<a class="download" href="${escapeHtml(installLink)}">Download Agent Time for Mac <span aria-hidden="true">↓</span></a><p class="note">Version ${escapeHtml(version)} · Apple Silicon · Developer ID signed and notarized</p>`
    : '<div class="pending"><span class="dot" aria-hidden="true"></span><strong>Public beta</strong><span>The installer is being prepared.</span></div>';
  const finalDownload = installLink
    ? `<a class="download" href="${escapeHtml(installLink)}">Download Agent Time for Mac <span aria-hidden="true">↓</span></a>`
    : '<p class="note">The installer is being prepared.</p>';
  const sources = SOURCES.map(({group, name, detail}) => `<article class="source"><span class="source-group">${group}</span><h3>${name}</h3><p>${detail}</p></article>`).join('');
  const questions = QUESTIONS.map(([question, answer]) => `<details><summary>${question}</summary><p>${answer}</p></details>`).join('');
  const guides = DOC_PAGES.map(page => `<a class="guide" href="/docs/${escapeHtml(page.slug)}"><span>${escapeHtml(page.kicker)}</span><h3>${escapeHtml(page.title)}</h3><p>${escapeHtml(page.description)}</p><b aria-hidden="true">↗</b></a>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#131209">
  <meta name="description" content="Track Mac activity and AI agents locally. Review project time, prepare versioned billing reports and connect Claude Code or Codex through MCP. Explore the complete setup and capture guides.">
  <meta property="og:title" content="Agent Time · the timesheet that counts your agents">
  <meta property="og:description" content="Your Mac activity and your agents' work on one local timeline.">
  <meta property="og:image" content="https://agent-time.ezyostudio.com/icon.png?v=e75e03c6c425">
  <meta property="og:url" content="https://agent-time.ezyostudio.com/">
  <meta name="twitter:card" content="summary">
  <link rel="canonical" href="https://agent-time.ezyostudio.com/">
  <link rel="icon" type="image/png" href="/icon.png?v=e75e03c6c425">
  <title>Agent Time · open source time tracking for Mac and AI agents</title>
  <style>
    @font-face { font-family: Manrope; src: url('/manrope.ttf') format('truetype'); font-style: normal; font-weight: 200 800; font-display: swap; }
    :root {
      --bg: #131209; --raised: #1f1f1f; --line: #313131; --text: #f5f5f3; --muted: #a5a69d; --faint: #92958a;
      --human: #e8a25c; --agent: #a48df0; --sub: #5d527f; --accent: #c5e476;
      --mono: ui-monospace, 'SF Mono', Menlo, monospace; --ease: cubic-bezier(.32,.72,0,1);
      font-family: Manrope, sans-serif; color: var(--text); background: var(--bg);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; min-width: 0; background: var(--bg); }
    a { color: inherit; }
    a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 4px; }
    .skip { position: absolute; top: -80px; left: 24px; z-index: 10; padding: 8px 12px; border-radius: 8px; background: var(--text); color: var(--bg); font-weight: 600; }
    .skip:focus { top: 12px; }
    .shell { width: min(100% - 48px, 1120px); margin: 0 auto; }
    h1, h2, h3 { text-wrap: balance; font-weight: 700; }
    p { text-wrap: pretty; }

    nav { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 80px; }
    .wordmark { display: inline-flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 14px; line-height: 20px; text-decoration: none; }
    .wordmark img { width: 24px; height: 24px; border-radius: 6px; }
    .wordmark span { color: var(--faint); }
    .nav-links { display: flex; gap: 24px; font-size: 14px; line-height: 20px; color: var(--muted); }
    .nav-links a { text-decoration: none; transition: color 700ms var(--ease); }
    .nav-links a:hover { color: var(--text); }

    .hero { padding: 96px 0 0; text-align: center; }
    h1 { max-width: 680px; margin: 0 auto; padding-bottom: 8px; font-size: 72px; line-height: 1; letter-spacing: -.05em; background: linear-gradient(90deg, #fff, #9b9b9b); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .lead { max-width: 680px; margin: 16px auto 0; color: var(--muted); font-size: 18px; line-height: 28px; }
    .actions { display: flex; flex-direction: column; align-items: center; gap: 12px; margin-top: 40px; }
    .download { display: inline-flex; align-items: center; gap: 12px; padding: 8px 12px; min-height: 48px; border-radius: 8px; background: var(--text); color: var(--bg); font-size: 16px; line-height: 24px; font-weight: 600; text-decoration: none; transition: background 700ms var(--ease), transform 700ms var(--ease); }
    .download:hover { background: #dceabb; transform: translateY(-2px); }
    .download:active { transform: scale(.98); }
    .note { margin: 0; color: var(--faint); font-family: var(--mono); font-size: 12px; line-height: 16px; }
    .pending { display: inline-flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center; padding: 12px 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--raised); color: var(--muted); font-size: 14px; line-height: 20px; }
    .pending strong { color: var(--text); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
    .chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin: 48px auto 0; padding: 0; list-style: none; }
    .chips li { padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 12px; line-height: 16px; }

    .section { padding: 96px 0; }
    .label { margin: 0 0 16px; color: var(--faint); font-family: var(--mono); font-size: 12px; line-height: 16px; }
    .section h2 { max-width: 680px; margin: 0; font-size: 48px; line-height: 1; letter-spacing: -.04em; }
    .intro { max-width: 600px; margin: 16px 0 0; color: var(--muted); font-size: 16px; line-height: 24px; }

    .compare { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 48px; }
    .panel { padding: 8px; border: 1px solid var(--line); border-radius: 16px; background: var(--raised); }
    .panel-head { display: flex; justify-content: space-between; gap: 12px; padding: 12px 16px; font-size: 14px; line-height: 20px; font-weight: 600; }
    .panel-head span:last-child { font-family: var(--mono); font-size: 12px; font-weight: 400; color: var(--faint); }
    .panel-head .bad { color: var(--human); }
    .panel-head .good { color: var(--accent); }
    .panel-body { min-height: 320px; padding: 24px; border-radius: 8px; background: #181818; }
    .memo { margin: 0; color: var(--muted); font-family: var(--mono); font-size: 14px; line-height: 24px; white-space: pre-wrap; }
    .memo s { color: var(--faint); }
    .memo mark { background: none; color: var(--human); }
    .axis { display: flex; justify-content: space-between; color: var(--faint); font-family: var(--mono); font-size: 12px; line-height: 16px; }
    .lane { margin-top: 16px; }
    .lane-name { display: flex; justify-content: space-between; margin-bottom: 8px; color: var(--muted); font-size: 12px; line-height: 16px; }
    .lane-name b { color: var(--text); font-family: var(--mono); font-weight: 400; }
    .bar { position: relative; height: 24px; border-radius: 4px; background: #272727; overflow: hidden; }
    .bar i { position: absolute; top: 0; bottom: 0; border-radius: 2px; }
    .bar.human i { background: var(--human); }
    .bar.agent i { background: var(--agent); }
    .bar.agent i.sub { background: var(--sub); top: 12px; }
    .totals { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 24px; }
    .total { padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
    .total span { display: block; color: var(--faint); font-size: 12px; line-height: 16px; }
    .total b { font-family: var(--mono); font-size: 18px; line-height: 28px; font-weight: 400; }

    .steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin: 48px 0 0; padding: 0; list-style: none; counter-reset: step; }
    .steps li { padding: 24px; border: 1px solid var(--line); border-radius: 16px; background: var(--raised); counter-increment: step; }
    .steps li::before { content: counter(step, decimal-leading-zero); color: var(--faint); font-family: var(--mono); font-size: 12px; line-height: 16px; }
    .steps h3 { margin: 24px 0 8px; font-size: 18px; line-height: 28px; letter-spacing: -.02em; }
    .steps p { margin: 0; color: var(--muted); font-size: 14px; line-height: 20px; }
    .terminal { margin: 16px 0 0; padding: 24px; border: 1px solid var(--line); border-radius: 16px; background: #000; color: var(--muted); font-family: var(--mono); font-size: 14px; line-height: 24px; overflow-x: auto; white-space: pre; }
    .terminal b { color: var(--text); font-weight: 400; }
    .terminal .h { color: var(--human); }
    .terminal .a { color: var(--agent); }
    .terminal .w { color: var(--accent); }

    .tagline { padding: 96px 0; }
    .tagline p { max-width: 900px; margin: 0; font-size: 60px; line-height: 1; letter-spacing: -.04em; font-weight: 700; text-wrap: balance; }

    .sources { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-top: 48px; }
    .source { padding: 24px; border: 1px solid var(--line); border-radius: 16px; background: var(--raised); transition: transform 700ms var(--ease), border-color 700ms var(--ease); }
    .source:hover { transform: translateY(-4px); border-color: #4a4a42; }
    .source-group { color: var(--faint); font-family: var(--mono); font-size: 12px; line-height: 16px; }
    .source h3 { margin: 16px 0 8px; font-size: 18px; line-height: 28px; letter-spacing: -.02em; }
    .source p { margin: 0; color: var(--muted); font-size: 14px; line-height: 20px; }
    .guides { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 48px; }
    .guide { position: relative; display: block; padding: 24px 48px 24px 24px; border: 1px solid var(--line); border-radius: 16px; background: var(--raised); text-decoration: none; transition: border-color 700ms var(--ease), transform 700ms var(--ease); }
    .guide:hover { border-color: var(--accent); transform: translateY(-2px); }
    .guide:active { transform: translateY(1px); }
    .guide:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
    .guide span { color: var(--accent); font-size: 12px; line-height: 16px; }
    .guide h3 { margin: 12px 0 8px; font-size: 20px; line-height: 28px; }
    .guide p { margin: 0; color: var(--muted); font-size: 14px; line-height: 20px; }
    .guide b { position: absolute; right: 24px; top: 24px; color: var(--faint); font-weight: 400; }
    .text-link { color: var(--accent); text-underline-offset: 4px; }
    .section-link { display: inline-block; margin-top: 24px; }

    .questions { max-width: 760px; margin-top: 48px; }
    .questions details { padding: 24px 0; border: 1px solid transparent; border-top-color: var(--line); }
    .questions details:last-child { border-bottom-color: var(--line); }
    .questions summary { cursor: pointer; font-size: 16px; line-height: 24px; font-weight: 600; list-style: none; display: flex; justify-content: space-between; gap: 16px; }
    .questions summary::-webkit-details-marker { display: none; }
    .questions summary::after { content: '+'; color: var(--faint); font-family: var(--mono); transition: transform 700ms var(--ease); }
    .questions details[open] summary::after { transform: rotate(45deg); }
    .questions details p { margin: 12px 0 0; max-width: 640px; color: var(--muted); font-size: 14px; line-height: 20px; }

    .final { text-align: center; }
    .final h2, .final .intro { margin-inline: auto; }
    .final .actions { margin-top: 32px; }

    footer { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; padding: 32px 0 48px; border: 1px solid transparent; border-top-color: var(--line); color: var(--faint); font-size: 12px; line-height: 20px; }
    footer a { color: var(--muted); text-underline-offset: 3px; }

    @media (prefers-reduced-motion: no-preference) {
      @supports (animation-timeline: view()) {
        .rise { animation: rise linear both; animation-timeline: view(); animation-range: entry 0% entry 60%; }
        .tagline span { color: rgb(245 245 243 / .3); animation: light linear both; animation-timeline: view(); animation-range: cover calc(18% + var(--i) * 1.6%) cover calc(22% + var(--i) * 1.6%); }
      }
    }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
    @keyframes rise { from { opacity: 0; transform: translateY(64px); filter: blur(12px); } to { opacity: 1; transform: none; filter: none; } }
    @keyframes light { from { color: rgb(245 245 243 / .3); } to { color: var(--text); } }

    @media (max-width: 900px) {
      .steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .sources { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .compare { grid-template-columns: minmax(0, 1fr); }
      h1 { font-size: 60px; }
      .tagline p { font-size: 48px; }
    }
    @media (max-width: 600px) {
      .shell { width: min(100% - 32px, 1120px); }
      nav { flex-wrap: wrap; padding-block: 16px; }
      .nav-links { max-width: 100%; gap: 16px; flex-wrap: wrap; font-size: 12px; line-height: 16px; }
      .hero { padding-top: 64px; }
      h1 { font-size: 48px; }
      .lead { font-size: 16px; line-height: 24px; }
      .section, .tagline { padding: 64px 0; }
      .section h2 { font-size: 36px; line-height: 40px; }
      .tagline p { font-size: 36px; line-height: 40px; }
      .steps, .sources, .guides { grid-template-columns: minmax(0, 1fr); }
      .panel-body { padding: 16px; }
      .totals { grid-template-columns: minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <a class="skip" href="#content">Skip to content</a>
  <header class="shell">
    <nav aria-label="Main">
      <a class="wordmark" href="#top" aria-current="page"><img src="/icon.png?v=e75e03c6c425" alt=""><span>/</span>agent-time</a>
      <div class="nav-links"><a href="#how">How it works</a><a href="#mcp">MCP</a><a href="/docs">Guides</a><a href="#questions">Questions</a><a href="https://github.com/zaosoula/agent-time">GitHub</a></div>
    </nav>
  </header>
  <main id="content">
    <section class="hero" id="top" aria-labelledby="hero-title"><div class="shell">
      <h1 id="hero-title">See your work time.<br>Agents included.</h1>
      <p class="lead">Capture Mac activity and agent sessions on one local timeline. Review project attribution, prepare billing reports and let your agents report context through MCP.</p>
      <div class="actions" id="download">${download}<a class="text-link" href="/docs/getting-started">Set up your first day</a></div>
      <ul class="chips" aria-label="Works with"><li>Claude Code</li><li>Codex</li><li>Orca</li><li>Safari</li><li>Chrome</li><li>Brave</li><li>Git</li><li>Linear</li><li>MCP</li></ul>
    </div></section>

    <section class="section" aria-labelledby="compare-title"><div class="shell">
      <p class="label">An illustrative day</p>
      <h2 id="compare-title" class="rise">One day, two records.</h2>
      <p class="intro">See your own activity beside each agent execution. Keep cumulative agent time, any agent wall time and the shared clock distinct. The example below illustrates the difference.</p>
      <div class="compare">
        <figure class="panel rise" style="margin:0">
          <figcaption class="panel-head"><span>Without Agent Time</span><span class="bad">4 gaps</span></figcaption>
          <div class="panel-body"><p class="memo">thu
billing api: <s>6h?</s> 5h maybe
claude did the migration, <mark>how long?</mark>
codex reviewed docs in the background
<mark>lunch to 15:00 unclear</mark>
read stripe docs... counts?
two worktrees open, <mark>which project</mark>
<mark>forgot to stop timer</mark></p></div>
        </figure>
        <figure class="panel rise" style="margin:0" aria-label="Example Agent Time day: 5 hours 38 minutes human, 4 hours 51 minutes agent, 7 hours 26 minutes elapsed">
          <figcaption class="panel-head"><span>With Agent Time</span><span class="good">reviewed</span></figcaption>
          <div class="panel-body">
            <div class="axis" aria-hidden="true"><span>09:00</span><span>12:00</span><span>15:00</span><span>18:00</span></div>
            <div class="lane" aria-hidden="true"><div class="lane-name"><span>You on this Mac</span><b>5h 38m</b></div>
              <div class="bar human"><i style="left:2%;width:21%"></i><i style="left:26%;width:12%"></i><i style="left:52%;width:16%"></i><i style="left:72%;width:14%"></i></div></div>
            <div class="lane" aria-hidden="true"><div class="lane-name"><span>Agents</span><b>4h 51m</b></div>
              <div class="bar agent"><i style="left:14%;width:19%;height:12px"></i><i class="sub" style="left:18%;width:9%"></i><i style="left:40%;width:22%;height:12px"></i><i class="sub" style="left:46%;width:12%"></i><i style="left:78%;width:13%;height:12px"></i></div></div>
            <div class="totals"><div class="total"><span>Mac activity</span><b>5h 38m</b></div><div class="total"><span>Agent time</span><b>4h 51m</b></div><div class="total"><span>Elapsed</span><b>7h 26m</b></div></div>
          </div>
        </figure>
      </div>
      <a class="text-link section-link" href="/docs/time">Understand the time calculations ↗</a>
    </div></section>

    <section class="section" id="how" aria-labelledby="how-title"><div class="shell">
      <p class="label">How it works</p>
      <h2 id="how-title" class="rise">It records first, then asks.</h2>
      <p class="intro">Capture runs from the menu bar. Known projects are attributed automatically; unmatched and conflicting activity stays visible for review.</p>
      <ol class="steps">
        <li class="rise"><h3>Connect your agents</h3><p>Install Claude and Codex hooks user wide in one click, with local MCP tools beside them if you want. Other tools' entries are kept.</p></li>
        <li class="rise"><h3>Work as usual</h3><p>The menu bar clock shows today's Mac, agent and elapsed time. Closing the window keeps capture running.</p></li>
        <li class="rise"><h3>Review what needs you</h3><p>Group human activity by app and context. Filter unassigned time, assign a group, inspect its visits or split an interval.</p></li>
        <li class="rise"><h3>Prepare a report</h3><p>Export a weekly review or configure project billing. Saved billing reports retain their rates, counting method and coverage notes.</p></li>
      </ol>
      <div class="terminal rise" role="img" aria-label="Example My day summary"><b>Review</b> · Example day                                  <span class="w">2 to review</span>

<span class="h">human</span>    5h 38m   billing-api 3h 12m · docs 1h 04m · unassigned 1h 22m
<span class="a">agent</span>    4h 51m   claude 3h 40m · codex 1h 11m · 3 subagents
elapsed  7h 26m   overlap counted once

evidence  4 commits on billing-api · stripe.com/docs matched by rule</div>
    </div></section>

    <section class="section" id="mcp" aria-labelledby="mcp-title"><div class="shell">
      <p class="label">Local MCP</p>
      <h2 id="mcp-title" class="rise">Give the timeline context.</h2>
      <p class="intro">Claude Code and Codex can query captured time, declare a project and ticket, and keep task counters with renewable heartbeats. Observations and declarations stay distinct. Counter credit is optional; billing excludes declared counters.</p>
      <div class="terminal rise" role="img" aria-label="Example MCP query for time spent on an issue"><b>› how long have we spent on APP-42 this week?</b>

<span class="w">agent-time</span> · time_for_issue  APP-42  26 to 30 Oct
<span class="a">agent</span>      6h 12m   3 sessions · claude 4h 40m · codex 1h 32m
<span class="h">human</span>      2h 05m   matched by worktree app-42-search
suggested  0h 41m   linear.app page, not counted
coverage   1 session started before the lookback window</div>
      <a class="text-link section-link" href="/docs/mcp">Connect MCP and explore the tools ↗</a>
    </div></section>

    <section class="tagline" aria-label="Summary"><div class="shell">
      <p>${revealWords(['Your agents keep working', 'when you look away.', 'Now your timesheet does too.'])}</p>
    </div></section>

    <section class="section" id="sources" aria-labelledby="sources-title"><div class="shell">
      <p class="label">Capture and context</p>
      <h2 id="sources-title" class="rise">Every source has its own switch.</h2>
      <p class="intro">Turn sources on one by one in Settings. Disabled sources discard their backlog, so a pause never turns into counted time.</p>
      <div class="sources">${sources}</div>
    </div></section>

    <section class="section" id="guides" aria-labelledby="guides-title"><div class="shell">
      <p class="label">The field guide</p>
      <h2 id="guides-title">Understand every hour.</h2>
      <p class="intro">Start with setup, then follow the evidence from capture to a reviewed report. Each guide explains the controls, the calculations and their limits.</p>
      <div class="guides">${guides}</div>
    </div></section>

    <section class="section" id="questions" aria-labelledby="questions-title"><div class="shell">
      <p class="label">Questions</p>
      <h2 id="questions-title" class="rise">Before you install.</h2>
      <div class="questions">${questions}</div>
    </div></section>

    <section class="section final" aria-labelledby="final-title"><div class="shell">
      <p class="label">Open source public beta</p>
      <h2 id="final-title" class="rise">See the whole day, not half of it.</h2>
      <p class="intro">Free and MIT licensed. Pause capture or remove every hook whenever you want.</p>
      <div class="actions">${finalDownload}</div>
    </div></section>
  </main>
  <footer class="shell"><span>Agent Time by Ezyo Studio · Public beta for Apple Silicon Macs</span><span><a href="/docs">Documentation</a> · <a href="/docs/privacy-storage">Privacy &amp; storage</a> · <a href="https://github.com/zaosoula/agent-time/blob/main/docs/beta/privacy.md">Beta data notice</a> · <a href="https://github.com/zaosoula/agent-time/blob/main/LICENSE">MIT license</a> · <a href="https://github.com/zaosoula/agent-time">Source code</a> · <a href="mailto:zao.soula@ezyostudio.com">Support</a></span></footer>
</body>
</html>`;
}
