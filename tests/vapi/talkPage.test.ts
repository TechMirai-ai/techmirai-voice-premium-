import { describe, expect, test } from 'vitest';

import { renderTalkBootstrapScript, renderTalkPage } from '../../src/vapi/talkPage.js';

describe('renderTalkPage', () => {
  test('shows the clinic name and a single Talk button', () => {
    const html = renderTalkPage({
      clinicName: 'Sakura Seikotsuin',
      language: 'en',
      switchLinks: [],
      scriptSrc: '/talk/sakura-seikotsuin/en/bootstrap.js',
    });

    expect(html).toContain('Sakura Seikotsuin');
    expect(html).toContain('id="talk-button"');
    expect(html).toContain('>Talk<');
    expect(html).not.toContain('id="end-call-button"');
    expect(html).not.toContain('id="start-call-button"');
  });

  test('escapes the clinic name and language, preventing injection', () => {
    const html = renderTalkPage({
      clinicName: '<script>alert(1)</script>',
      language: '"><svg onload=alert(1)>',
      switchLinks: [],
      scriptSrc: '/talk/x/y/bootstrap.js',
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<svg onload');
  });

  test('omits the switch markup entirely when there is only one language', () => {
    const html = renderTalkPage({
      clinicName: 'Sakura Seikotsuin',
      language: 'ja',
      switchLinks: [],
      scriptSrc: '/talk/sakura-seikotsuin/ja/bootstrap.js',
    });

    expect(html).not.toContain('class="switch"');
  });

  test('renders a switch link to the other language, labeled with its own clinic name', () => {
    const html = renderTalkPage({
      clinicName: 'Sakura Seikotsuin',
      language: 'en',
      switchLinks: [{ label: 'さくら整骨院', href: '/talk/sakura-seikotsuin/ja' }],
      scriptSrc: '/talk/sakura-seikotsuin/en/bootstrap.js',
    });

    expect(html).toContain('href="/talk/sakura-seikotsuin/ja"');
    expect(html).toContain('さくら整骨院');
  });

  test('references the bootstrap script by src, as a same-origin module', () => {
    const html = renderTalkPage({
      clinicName: 'Sakura Seikotsuin',
      language: 'ja',
      switchLinks: [],
      scriptSrc: '/talk/sakura-seikotsuin/ja/bootstrap.js',
    });

    expect(html).toContain('<script type="module" src="/talk/sakura-seikotsuin/ja/bootstrap.js">');
  });

  test('never leaks a clientId slug anywhere in the visible markup', () => {
    const html = renderTalkPage({
      clinicName: 'Sakura Seikotsuin',
      language: 'ja',
      switchLinks: [],
      scriptSrc: '/talk/sakura-seikotsuin/ja/bootstrap.js',
    });

    // The script path legitimately contains the slug; the human-visible text must not.
    const visibleText = html.replace(/<script[\s\S]*?<\/script>/g, '');
    expect(visibleText).not.toContain('sakura-seikotsuin');
  });

  test('embeds the bypass key as a page global only when one is given', () => {
    const withKey = renderTalkPage({
      clinicName: 'Sakura Seikotsuin',
      language: 'ja',
      switchLinks: [],
      scriptSrc: '/talk/sakura-seikotsuin/ja/bootstrap.js',
      bypassKey: 'owner-secret-key',
    });
    const withoutKey = renderTalkPage({
      clinicName: 'Sakura Seikotsuin',
      language: 'ja',
      switchLinks: [],
      scriptSrc: '/talk/sakura-seikotsuin/ja/bootstrap.js',
    });

    expect(withKey).toContain('window.__TALK_BYPASS_KEY__ = "owner-secret-key"');
    expect(withoutKey).not.toContain('__TALK_BYPASS_KEY__');
  });
});

describe('renderTalkBootstrapScript', () => {
  test('embeds the public key and the gated calls URL, never a raw assistant id', () => {
    const script = renderTalkBootstrapScript({
      publicKey: 'pk_test_123',
      callsUrl: '/talk/sakura-seikotsuin/ja/calls',
    });

    expect(script).toContain('"pk_test_123"');
    expect(script).toContain('"/talk/sakura-seikotsuin/ja/calls"');
  });

  test('never logs the public key to the console (unlike the internal QA page)', () => {
    const script = renderTalkBootstrapScript({
      publicKey: 'pk_test_123',
      callsUrl: '/talk/sakura-seikotsuin/ja/calls',
    });

    expect(script).not.toContain('console.info');
    expect(script).not.toContain('console.log');
  });

  test('attaches an error listener before any call starts', () => {
    const script = renderTalkBootstrapScript({ publicKey: 'pk', callsUrl: '/calls' });

    const errorListenerIndex = script.indexOf("vapi.on('error'");
    const startCallIndex = script.indexOf('vapi.start(');
    expect(errorListenerIndex).toBeGreaterThan(-1);
    expect(errorListenerIndex).toBeLessThan(startCallIndex);
  });

  test('toggles the button between Talk and End on call-start/call-end', () => {
    const script = renderTalkBootstrapScript({ publicKey: 'pk', callsUrl: '/calls' });

    expect(script).toMatch(/call-start[\s\S]*?button\.textContent = 'End'/);
    expect(script).toMatch(/call-end[\s\S]*?button\.textContent = 'Talk'/);
  });

  test('requests the call session from the gated endpoint before starting the call', () => {
    const script = renderTalkBootstrapScript({ publicKey: 'pk', callsUrl: '/talk/x/ja/calls' });

    const fetchIndex = script.indexOf('fetch(');
    const startCallIndex = script.indexOf('vapi.start(');
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(fetchIndex).toBeLessThan(startCallIndex);
  });
});
