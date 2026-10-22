import { describe, expect, test } from 'vitest';

import { renderTalkBootstrapScript, renderTalkPage } from '../../src/vapi/talkPage.js';

describe('renderTalkPage', () => {
  test('puts a required phone-number field before the Talk button', () => {
    const html = renderTalkPage({
      clinicName: 'Sakura Seikotsuin',
      language: 'en',
      switchLinks: [],
      scriptSrc: '/talk/sakura-seikotsuin/en/bootstrap.js',
    });

    expect(html).toMatch(/<input[^>]*id="caller-phone"[^>]*type="tel"[^>]*required/);
    expect(html).toContain('autocomplete="tel"');
    expect(html.indexOf('id="caller-phone"')).toBeLessThan(html.indexOf('id="talk-button"'));
  });

  test('tells visitors to enter a made-up number, not their real one', () => {
    const html = renderTalkPage({
      clinicName: 'Sakura Seikotsuin',
      language: 'en',
      switchLinks: [],
      scriptSrc: '/x.js',
    });

    expect(html).toContain(
      "Enter any made-up number — this is just for testing, don't use your real one.",
    );
    expect(html).toContain('aria-describedby="caller-phone-hint"');
  });

  test('renders a hidden 00:00 timer, and the remaining-calls line only when a count is given', () => {
    const base = { clinicName: 'Sakura', language: 'en', switchLinks: [], scriptSrc: '/x.js' };

    expect(renderTalkPage(base)).toMatch(/id="call-timer" hidden>00:00</);
    expect(renderTalkPage(base)).not.toContain('id="calls-remaining"');
    expect(renderTalkPage({ ...base, callsRemaining: 3 })).toContain('3 of 4 demo calls remaining');
  });

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

  test('plays a ringback tone on click, overlapping with (not blocking) the call-session request', () => {
    const script = renderTalkBootstrapScript({ publicKey: 'pk', callsUrl: '/talk/x/ja/calls' });

    const clickHandlerIndex = script.indexOf("addEventListener('click'");
    const ringbackCallIndex = script.indexOf('= playRingback();');
    const startCallIndex = script.indexOf('vapi.start(');
    expect(script).toContain('function playRingback()');
    expect(ringbackCallIndex).toBeGreaterThan(clickHandlerIndex);
    expect(ringbackCallIndex).toBeLessThan(startCallIndex);
    // Both the ringback and the session fetch are awaited together (Promise.all)
    // before starting the call, so neither one blocks on the other individually.
    expect(script).toMatch(/Promise\.all\(\[ringbackDone, sessionDone\]\)/);
  });

  test('never fails the call if ringback playback itself errors', () => {
    const script = renderTalkBootstrapScript({ publicKey: 'pk', callsUrl: '/calls' });

    const playRingbackBody = script.slice(
      script.indexOf('function playRingback()'),
      script.indexOf('button.addEventListener'),
    );
    expect(playRingbackBody).toContain('try {');
    expect(playRingbackBody).toMatch(/catch[\s\S]*resolve\(\);/);
  });

  test('sends the entered number with the call-session request and hands the returned variables to Vapi', () => {
    const script = renderTalkBootstrapScript({ publicKey: 'pk', callsUrl: '/talk/x/ja/calls' });

    expect(script).toContain("getElementById('caller-phone')");
    expect(script).toContain('callerPhone');
    expect(script).toContain('JSON.stringify');
    expect(script).toContain('variableValues: data.variableValues');
    expect(script).toContain('vapi.start(data.assistantId, overrides)');
  });

  test('passes a returning-caller firstMessage override to Vapi only when the server sent one', () => {
    const script = renderTalkBootstrapScript({ publicKey: 'pk', callsUrl: '/talk/x/ja/calls' });

    expect(script).toContain('data.firstMessage');
    expect(script).toMatch(/if \(data\.firstMessage\)/);
  });

  test('starts the mm:ss timer when the call connects and stops it when the call ends or errors', () => {
    const script = renderTalkBootstrapScript({ publicKey: 'pk', callsUrl: '/talk/x/ja/calls' });
    const handler = (event: string) => {
      const start = script.indexOf(`vapi.on('${event}'`);
      return script.slice(start, script.indexOf('});', start));
    };

    expect(handler('call-start')).toContain('startTimer()');
    expect(handler('call-end')).toContain('stopTimer()');
    expect(handler('error')).toContain('stopTimer()');
    expect(script).toContain("getElementById('call-timer')");
  });

  test('updates the remaining-calls line from the server response, and to 0 on a rejection', () => {
    const script = renderTalkBootstrapScript({ publicKey: 'pk', callsUrl: '/talk/x/ja/calls' });

    expect(script).toContain('showCallsRemaining(data.callsRemaining)');
    expect(script).toContain('showCallsRemaining(0)');
  });

  test('refuses to start a call with an empty number, and explains a server-side rejection', () => {
    const script = renderTalkBootstrapScript({ publicKey: 'pk', callsUrl: '/talk/x/ja/calls' });

    expect(script).toContain('res.status === 400');
    expect(script).toMatch(/phoneInput\.value\.trim\(\)/);
  });
});
