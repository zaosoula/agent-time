import { test } from 'node:test';import assert from 'node:assert/strict';
import { renderReport } from '../src/capture/report.ts';import { summarize } from '../src/capture/correlate.ts';
test('reports escape external content and expose live versus simulated proof',()=>{
 const html=renderReport(summarize([]),[{scenario:'<script>alert(1)</script>',mode:'live',status:'unverified',evidence:'No binding'}]);
 assert.ok(!html.includes('<script>alert(1)</script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('unverified'));assert.ok(html.includes('live'));
});
