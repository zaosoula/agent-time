import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkBundledNode} from '../scripts/node-runtime.mjs';

const system=`/opt/node/bin/node:
\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0)
\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)`;

test('a self-contained Node matching the engine major can be bundled',()=>{
 assert.deepEqual(checkBundledNode({version:'26.9.0',engines:'>=26.9.0',arch:'arm64',libraries:system}),[]);
 assert.deepEqual(checkBundledNode({version:'26.12.1',engines:'>=26.9.0',arch:'x64',libraries:system}),[]);
});

test('other majors, older releases and Homebrew-linked builds are refused',()=>{
 assert.match(checkBundledNode({version:'27.0.0',engines:'>=26.9.0',arch:'arm64',libraries:system}).join(),/major 27/);
 assert.match(checkBundledNode({version:'26.1.0',engines:'>=26.9.0',arch:'arm64',libraries:system}).join(),/older/);
 const brew=`${system}\n\t/opt/homebrew/opt/icu4c/lib/libicui18n.76.dylib (compatibility version 76.0.0)\n\t/opt/homebrew/Cellar/node/26.9.0/lib/libnode.141.dylib (compatibility version 0.0.0)`;
 const problems=checkBundledNode({version:'26.9.0',engines:'>=26.9.0',arch:'arm64',libraries:brew}).join();
 assert.match(problems,/libicui18n/);assert.match(problems,/libnode/);
});
