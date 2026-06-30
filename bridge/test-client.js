#!/usr/bin/env node
/*
 * Stand-in for the Firefox extension: frames a single native-messaging request,
 * pipes it to host.js, and pretty-prints every framed response. Lets us exercise
 * the whole bridge -> claude -> userscript path from the CLI.
 *
 * Usage:
 *   node bridge/test-client.js "<prompt>" [domain] [url]
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const prompt = process.argv[2] || 'Add a red banner at the top of the page that says "ClaudeMonkey works".';
const domain = process.argv[3] || 'example.com';
const url = process.argv[4] || `https://${domain}/`;

const req = {
  type: 'generate',
  requestId: 'test-1',
  domain,
  url,
  prompt,
  domSnapshot: '<html><head><title>Example</title></head><body><h1>Example Domain</h1><p>Some text.</p></body></html>',
};

function frame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

const child = spawn(process.execPath, [path.join(__dirname, 'host.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

child.stdin.write(frame(req));
// keep stdin open so the host stays alive; close after we see `done`.

let buf = Buffer.alloc(0);
child.stdout.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const body = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    const msg = JSON.parse(body.toString('utf8'));
    if (msg.type === 'narration') {
      process.stdout.write(`\n[narration] ${msg.text}\n`);
    } else if (msg.type === 'tool') {
      process.stdout.write(`[tool] ${msg.summary}\n`);
    } else if (msg.type === 'session') {
      process.stdout.write(`[session] ${msg.sessionId}\n`);
    } else if (msg.type === 'done') {
      process.stdout.write(`\n[done] exit=${msg.exitCode} cost=$${msg.cost || 0}\n`);
      if (msg.error) process.stdout.write(`[error] ${msg.error}\n`);
      process.stdout.write(`\n----- userscript.user.js -----\n${msg.script || '(none)'}\n`);
      child.stdin.end();
      process.exit(msg.error ? 1 : 0);
    } else {
      process.stdout.write(`[${msg.type}] ${JSON.stringify(msg)}\n`);
    }
  }
});
