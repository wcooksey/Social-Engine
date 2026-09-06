#!/usr/bin/env node
/**
 * One-time social login capture.
 *
 * Run this ONCE per social account, on your own machine (it opens a real
 * browser window). You log in normally — including 2FA — and it saves the
 * resulting session (cookies + localStorage) to a JSON file. Upload that file
 * in Settings → Social accounts, and Neuralnetics stays logged in for weeks,
 * auto-refreshing on every use. No per-lead login.
 *
 * Usage:
 *   node scripts/capture-social-login.mjs linkedin
 *   node scripts/capture-social-login.mjs facebook ./sessions/fb.json
 *
 * Requires: npm i -D playwright  (and a headed environment / desktop).
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { createInterface } from 'readline';

const PLATFORM_URLS = {
  linkedin: 'https://www.linkedin.com/login',
  facebook: 'https://www.facebook.com/login',
  instagram: 'https://www.instagram.com/accounts/login/',
  x: 'https://x.com/login',
};

const platform = (process.argv[2] || '').toLowerCase();
const outPath = process.argv[3] || `./${platform}-session.json`;

if (!PLATFORM_URLS[platform]) {
  console.error(`Usage: node scripts/capture-social-login.mjs <${Object.keys(PLATFORM_URLS).join('|')}> [outPath]`);
  process.exit(1);
}

const ask = (q) =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      resolve(a);
    });
  });

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(PLATFORM_URLS[platform]);

console.log(`\nA browser window opened at ${platform}. Log in fully (complete any 2FA).`);
await ask('When you are logged in and see your home feed, press Enter here to save the session... ');

const state = await context.storageState();
writeFileSync(outPath, JSON.stringify(state, null, 2));
await browser.close();

console.log(`\n✅ Saved session to ${outPath}`);
console.log('Upload its contents in Settings → Social accounts for this platform.');
