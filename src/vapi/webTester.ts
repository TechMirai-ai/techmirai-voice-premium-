/**
 * Dedicated local web server and browser-based manual text-tester for the
 * Vapi AI prompt (turn-by-turn testing with model responses and tool calls).
 *
 * Reuses the EXACT production prompt building, tool definitions, FAQ loaders,
 * and OpenAI turn execution loop from `src/vapi/textTester.ts` and `src/vapi/render.ts`.
 *
 * ZERO DRIFT FROM PRODUCTION: All prompt generation, tool schema conversion,
 * and turn handling are imported directly.
 */
import { randomUUID } from 'node:crypto';
import { type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Express, type Request, type Response } from 'express';

import { loadClient } from '../config/loadClient.js';
import { createPool } from '../db/pool.js';
import { loadEnv } from '../env.js';
import {
  PgCallbackRequestRepository,
  type CallbackRequestRepository,
} from '../repositories/callbackRequestRepository.js';
import { contentLanguageOf, squadMemberIds } from './squad.js';
import {
  buildToolDefs,
  initialMessages,
  loadRenderedMember,
  makeOpenAiCaller,
  OPENAI_MODEL,
  runTurn,
  type CallModelFn,
  type ChatMessage,
  type OpenAiFunctionToolDef,
  type ToolCallHandlerDeps,
} from './textTester.js';

export const DEFAULT_WEB_TESTER_PORT = 3002;
export const DEFAULT_CLIENT_ID = 'sakura-seikotsuin';

export interface WebTesterSession {
  id: string;
  clientId: string;
  member: string;
  persist: boolean;
  language: string;
  callId: string;
  tools: OpenAiFunctionToolDef[];
  messages: ChatMessage[];
  createdAt: Date;
}

export interface ExtractedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
  result: string;
}

export interface WebTesterOptions {
  apiKey?: string | undefined;
  callModel?: CallModelFn | undefined;
  callbacks?: CallbackRequestRepository | undefined;
  databaseUrl?: string | undefined;
}

interface SessionRequestBody {
  clientId?: string | undefined;
  member?: string | undefined;
  persist?: boolean | undefined;
}

interface TurnRequestBody {
  sessionId?: string | undefined;
  message?: string | undefined;
  persist?: boolean | undefined;
}

export function createWebTesterApp(options: WebTesterOptions = {}): Express {
  const app = express();
  app.use(express.json());

  const sessions = new Map<string, WebTesterSession>();
  let sharedDbCallbacks = options.callbacks;

  function getCallbacks(dbUrl?: string): CallbackRequestRepository | undefined {
    if (sharedDbCallbacks) return sharedDbCallbacks;
    if (dbUrl) {
      const pool = createPool({ connectionString: dbUrl });
      sharedDbCallbacks = new PgCallbackRequestRepository(pool);
      return sharedDbCallbacks;
    }
    return undefined;
  }

  // Configuration endpoint
  app.get('/api/config', (_req: Request, res: Response) => {
    try {
      const config = loadClient(DEFAULT_CLIENT_ID);
      const members = squadMemberIds(config);
      res.json({
        defaultClientId: DEFAULT_CLIENT_ID,
        members,
        model: OPENAI_MODEL,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Start / Reset Session
  app.post('/api/session', async (req: Request<unknown, unknown, SessionRequestBody>, res: Response) => {
    try {
      const clientId = req.body.clientId ?? DEFAULT_CLIENT_ID;
      const member = req.body.member ?? 'ja';
      const persist = Boolean(req.body.persist);

      const config = loadClient(clientId);
      const language = contentLanguageOf(config, member);
      const rendered = await loadRenderedMember(clientId, member);
      const tools = buildToolDefs(rendered);
      const messages = initialMessages(rendered);

      const sessionId = randomUUID();
      const callId = `web-tester-${Date.now()}`;

      const session: WebTesterSession = {
        id: sessionId,
        clientId,
        member,
        persist,
        language,
        callId,
        tools,
        messages,
        createdAt: new Date(),
      };

      sessions.set(sessionId, session);

      res.json({
        sessionId,
        clientId,
        member,
        language,
        persist,
        model: OPENAI_MODEL,
        greeting: rendered.assistant.firstMessage,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Send turn / message
  app.post('/api/turn', async (req: Request<unknown, unknown, TurnRequestBody>, res: Response) => {
    try {
      const sessionId = req.body.sessionId ?? '';
      const userMessage = req.body.message?.trim();
      const persistOverride = req.body.persist;

      if (!sessionId || !sessions.has(sessionId)) {
        res.status(404).json({ error: 'Session not found. Please start a new conversation.' });
        return;
      }

      if (!userMessage) {
        res.status(400).json({ error: 'Message cannot be empty.' });
        return;
      }

      const session = sessions.get(sessionId)!;
      if (persistOverride !== undefined) {
        session.persist = Boolean(persistOverride);
      }

      // Append user message
      session.messages = [...session.messages, { role: 'user', content: userMessage }];
      const startIndex = session.messages.length;

      // Determine model caller
      let caller: CallModelFn;
      if (options.callModel) {
        caller = options.callModel;
      } else {
        const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
        if (!apiKey) {
          res.status(500).json({ error: 'OPENAI_API_KEY is not configured in .env' });
          return;
        }
        caller = makeOpenAiCaller(apiKey);
      }

      // Determine callback repo for persistence
      const callbacks = session.persist
        ? getCallbacks(options.databaseUrl || process.env.DATABASE_URL)
        : undefined;

      const logs: string[] = [];
      const toolDeps: ToolCallHandlerDeps = {
        persist: session.persist,
        clientId: session.clientId,
        language: session.language,
        callId: session.callId,
        ...(callbacks ? { callbacks } : {}),
        printLine: (line) => logs.push(line),
      };

      const result = await runTurn(session.messages, session.tools, caller, toolDeps);
      session.messages = result.messages;

      // Extract new turn messages
      const newMessages = session.messages.slice(startIndex);
      const toolCalls: ExtractedToolCall[] = [];
      const agentReplies: string[] = [];

      for (const msg of newMessages) {
        if (msg.role === 'assistant') {
          if (msg.content) {
            agentReplies.push(msg.content);
          }
          if (msg.tool_calls) {
            for (const call of msg.tool_calls) {
              let parsedArgs: Record<string, unknown> = {};
              try {
                parsedArgs = JSON.parse(call.function.arguments) as Record<string, unknown>;
              } catch {
                parsedArgs = { raw: call.function.arguments };
              }

              // Locate corresponding tool message
              const toolMsg = newMessages.find(
                (m) => m.role === 'tool' && m.tool_call_id === call.id,
              );
              toolCalls.push({
                id: call.id,
                name: call.function.name,
                arguments: parsedArgs,
                rawArguments: call.function.arguments,
                result: toolMsg?.content ?? 'Success.',
              });
            }
          }
        }
      }

      res.json({
        ended: result.ended,
        agentReply: agentReplies.join('\n\n'),
        toolCalls,
        logs,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Serve Single-Page App HTML
  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(renderWebTesterHtml());
  });

  return app;
}

export function renderWebTesterHtml(): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TechMirai Voice — AI Prompt Text Tester</title>
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    :root {
      --bg-canvas: #f8f9fa;
      --bg-surface: #ffffff;
      --bg-subtle: #f1f5f9;
      --border-light: #e2e8f0;
      --border-medium: #cbd5e1;
      --text-main: #1e293b;
      --text-sub: #475569;
      --text-muted: #94a3b8;
      --brand-navy: #1e293b;
      --brand-navy-hover: #0f172a;
      --accent-blue: #2563eb;
      --tool-amber-bg: #fffbeb;
      --tool-amber-border: #fcd34d;
      --tool-amber-text: #92400e;
      --danger-bg: #fef2f2;
      --danger-border: #fecaca;
      --danger-text: #991b1b;
      --success-bg: #ecfdf5;
      --success-border: #a7f3d0;
      --success-text: #065f46;
    }

    body {
      background-color: var(--bg-canvas);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif;
      font-size: 15px;
      line-height: 1.6;
      letter-spacing: 0.02em;
      -webkit-font-smoothing: antialiased;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Top Navigation Header */
    .app-header {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-light);
      padding: 0.75rem 1.5rem;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      z-index: 10;
    }

    .header-brand {
      display: flex;
      flex-direction: column;
    }

    .header-title {
      font-size: 1.1rem;
      font-weight: 600;
      color: var(--brand-navy);
      letter-spacing: -0.01em;
    }

    .header-subtitle {
      font-size: 0.75rem;
      color: var(--text-muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    .header-controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.85rem;
    }

    .control-group {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .control-label {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-sub);
    }

    select, input[type="checkbox"], button {
      font-family: inherit;
    }

    select {
      background: var(--bg-surface);
      border: 1px solid var(--border-medium);
      border-radius: 4px;
      padding: 0.35rem 0.65rem;
      font-size: 0.825rem;
      color: var(--text-main);
      cursor: pointer;
      outline: none;
    }

    select:focus {
      border-color: var(--accent-blue);
      box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.1);
    }

    .checkbox-label {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-size: 0.8rem;
      color: var(--text-sub);
      cursor: pointer;
      user-select: none;
    }

    .btn {
      padding: 0.4rem 0.85rem;
      border-radius: 4px;
      font-size: 0.825rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      letter-spacing: 0.02em;
    }

    .btn-secondary {
      background: transparent;
      border: 1px solid var(--border-medium);
      color: var(--text-sub);
    }

    .btn-secondary:hover {
      background: var(--bg-subtle);
      color: var(--brand-navy);
      border-color: var(--text-muted);
    }

    .status-badge {
      font-size: 0.725rem;
      font-weight: 600;
      padding: 0.2rem 0.5rem;
      border-radius: 9999px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .status-badge.ready {
      background: var(--bg-subtle);
      color: var(--text-sub);
      border: 1px solid var(--border-light);
    }

    .status-badge.busy {
      background: #eff6ff;
      color: #1d4ed8;
      border: 1px solid #bfdbfe;
    }

    .status-badge.ended {
      background: var(--tool-amber-bg);
      color: var(--tool-amber-text);
      border: 1px solid var(--tool-amber-border);
    }

    .status-badge.error {
      background: var(--danger-bg);
      color: var(--danger-text);
      border: 1px solid var(--danger-border);
    }

    /* Main Timeline Container */
    .timeline-container {
      flex: 1;
      overflow-y: auto;
      padding: 1.5rem 1rem;
      display: flex;
      justify-content: center;
    }

    .timeline-inner {
      width: 100%;
      max-width: 820px;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    /* System Banner */
    .system-banner {
      background: var(--bg-surface);
      border: 1px solid var(--border-light);
      border-radius: 6px;
      padding: 0.75rem 1rem;
      font-size: 0.8rem;
      color: var(--text-sub);
      line-height: 1.5;
    }

    .system-banner code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background: var(--bg-subtle);
      padding: 0.1rem 0.3rem;
      border-radius: 3px;
      color: var(--brand-navy);
    }

    /* Message Items */
    .chat-item {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      animation: fadeIn 0.15s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .item-sender {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    /* User Message */
    .chat-item.user {
      align-items: flex-end;
    }

    .chat-item.user .bubble {
      background: var(--brand-navy);
      color: #ffffff;
      border-radius: 8px 8px 2px 8px;
      padding: 0.75rem 1rem;
      max-width: 80%;
      font-size: 0.925rem;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* Assistant Message */
    .chat-item.assistant {
      align-items: flex-start;
    }

    .chat-item.assistant .bubble {
      background: var(--bg-surface);
      color: var(--text-main);
      border: 1px solid var(--border-light);
      border-radius: 8px 8px 8px 2px;
      padding: 0.85rem 1.15rem;
      max-width: 85%;
      font-size: 0.925rem;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
    }

    /* Tool Call Card */
    .tool-call-card {
      background: #fafaf9;
      border: 1px solid var(--border-medium);
      border-left: 4px solid #f59e0b;
      border-radius: 6px;
      padding: 0.75rem 1rem;
      margin: 0.25rem 0;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      font-size: 0.825rem;
    }

    .tool-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .tool-title {
      font-weight: 600;
      color: #b45309;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }

    .tool-args {
      background: var(--bg-surface);
      border: 1px solid var(--border-light);
      border-radius: 4px;
      padding: 0.5rem 0.75rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.8rem;
      color: var(--text-main);
      white-space: pre-wrap;
      word-break: break-all;
    }

    .tool-result {
      font-size: 0.775rem;
      color: var(--text-sub);
      display: flex;
      align-items: center;
      gap: 0.35rem;
    }

    .tool-result-badge {
      display: inline-block;
      padding: 0.15rem 0.4rem;
      border-radius: 3px;
      background: var(--success-bg);
      border: 1px solid var(--success-border);
      color: var(--success-text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }

    /* Call Ended Notice */
    .call-ended-notice {
      background: var(--bg-surface);
      border: 1px dashed var(--border-medium);
      border-radius: 6px;
      padding: 0.75rem 1rem;
      text-align: center;
      color: var(--text-sub);
      font-size: 0.85rem;
      margin: 0.5rem 0;
    }

    /* Input Footer */
    .app-footer {
      background: var(--bg-surface);
      border-top: 1px solid var(--border-light);
      padding: 0.85rem 1.5rem;
      display: flex;
      justify-content: center;
      z-index: 10;
    }

    .input-form {
      width: 100%;
      max-width: 820px;
      display: flex;
      gap: 0.75rem;
      align-items: flex-end;
    }

    .input-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    textarea#user-input {
      width: 100%;
      height: 48px;
      min-height: 48px;
      max-height: 120px;
      padding: 0.65rem 0.85rem;
      border: 1px solid var(--border-medium);
      border-radius: 6px;
      font-family: inherit;
      font-size: 0.925rem;
      color: var(--text-main);
      background: var(--bg-surface);
      resize: vertical;
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    textarea#user-input:focus {
      border-color: var(--accent-blue);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    }

    textarea#user-input:disabled {
      background: var(--bg-subtle);
      color: var(--text-muted);
      cursor: not-allowed;
    }

    .input-hint {
      font-size: 0.725rem;
      color: var(--text-muted);
    }

    .btn-send {
      height: 48px;
      padding: 0 1.25rem;
      background: var(--brand-navy);
      color: #ffffff;
      border: 1px solid var(--brand-navy);
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn-send:hover:not(:disabled) {
      background: var(--brand-navy-hover);
      border-color: var(--brand-navy-hover);
    }

    .btn-send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    @media (max-width: 680px) {
      .app-header {
        padding: 0.75rem 1rem;
      }
      .app-footer {
        padding: 0.75rem 1rem;
      }
    }
  </style>
</head>
<body>
  <header class="app-header">
    <div class="header-brand">
      <h1 class="header-title">AI Prompt Text Tester</h1>
      <span class="header-subtitle">Model: gpt-4o-mini · Direct Logic QA</span>
    </div>

    <div class="header-controls">
      <div class="control-group">
        <label for="member-select" class="control-label">Member:</label>
        <select id="member-select">
          <option value="ja">ja (Japanese Primary)</option>
          <option value="en">en (English)</option>
          <option value="ja-return">ja-return (Japanese Return)</option>
        </select>
      </div>

      <div class="control-group">
        <label class="checkbox-label" title="When checked, request_callback tool calls actually save rows to local PostgreSQL">
          <input type="checkbox" id="persist-toggle" />
          <span>Persist to DB</span>
        </label>
      </div>

      <button id="reset-button" class="btn btn-secondary" type="button">New Session</button>
      <span id="status-badge" class="status-badge ready">Ready</span>
    </div>
  </header>

  <main class="timeline-container">
    <div class="timeline-inner" id="timeline">
      <!-- Chat history items will be injected here -->
    </div>
  </main>

  <footer class="app-footer">
    <form class="input-form" id="chat-form">
      <div class="input-wrapper">
        <textarea id="user-input" placeholder="Type caller utterance... (Press Enter to send, Shift+Enter for newline)"></textarea>
        <span class="input-hint">Enter to send · Shift+Enter for new line · /exit or Reset to restart</span>
      </div>
      <button type="submit" class="btn-send" id="send-button">
        <span>Send</span>
      </button>
    </form>
  </footer>

  <script>
    (function () {
      const timeline = document.getElementById('timeline');
      const userInput = document.getElementById('user-input');
      const sendButton = document.getElementById('send-button');
      const memberSelect = document.getElementById('member-select');
      const persistToggle = document.getElementById('persist-toggle');
      const resetButton = document.getElementById('reset-button');
      const statusBadge = document.getElementById('status-badge');
      const chatForm = document.getElementById('chat-form');

      let currentSessionId = null;
      let isBusy = false;
      let isCallEnded = false;

      function setStatus(status, text) {
        statusBadge.className = 'status-badge ' + status;
        statusBadge.textContent = text;
      }

      function scrollToBottom() {
        timeline.parentElement.scrollTop = timeline.parentElement.scrollHeight;
      }

      function appendSystemBanner(info) {
        const div = document.createElement('div');
        div.className = 'system-banner';
        div.innerHTML = 'Client: <code>' + escapeHtml(info.clientId) + '</code> · ' +
          'Member: <code>' + escapeHtml(info.member) + '</code> · ' +
          'Language: <code>' + escapeHtml(info.language) + '</code> · ' +
          'DB Persistence: <strong>' + (info.persist ? 'Enabled' : 'Disabled') + '</strong><br>' +
          '<small style="color: var(--text-muted); font-size: 0.75rem;">' +
          'Handoffs simulated: call ends when handoff tool is triggered. Switch member to continue from other side.' +
          '</small>';
        timeline.appendChild(div);
      }

      function appendMessage(role, content) {
        const item = document.createElement('div');
        item.className = 'chat-item ' + role;

        const sender = document.createElement('div');
        sender.className = 'item-sender';
        sender.textContent = role === 'user' ? 'Caller' : 'AI Assistant';
        item.appendChild(sender);

        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = content;
        item.appendChild(bubble);

        timeline.appendChild(item);
        scrollToBottom();
      }

      function appendToolCall(toolCall) {
        const card = document.createElement('div');
        card.className = 'tool-call-card';

        const header = document.createElement('div');
        header.className = 'tool-header';
        header.innerHTML = '<span class="tool-title">⚙️ Tool Call: ' + escapeHtml(toolCall.name) + '</span>';
        card.appendChild(header);

        const argsEl = document.createElement('div');
        argsEl.className = 'tool-args';
        argsEl.textContent = JSON.stringify(toolCall.arguments, null, 2);
        card.appendChild(argsEl);

        const resultEl = document.createElement('div');
        resultEl.className = 'tool-result';
        resultEl.innerHTML = '<span class="tool-result-badge">Result</span> ' + escapeHtml(toolCall.result);
        card.appendChild(resultEl);

        timeline.appendChild(card);
        scrollToBottom();
      }

      function appendCallEnded(message) {
        const div = document.createElement('div');
        div.className = 'call-ended-notice';
        div.textContent = '📞 ' + (message || 'Call ended.');
        timeline.appendChild(div);
        scrollToBottom();
      }

      function escapeHtml(str) {
        return String(str ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      async function initSession() {
        if (isBusy) return;
        isBusy = true;
        isCallEnded = false;
        userInput.disabled = true;
        sendButton.disabled = true;
        setStatus('busy', 'Initializing...');

        timeline.innerHTML = '';

        try {
          const res = await fetch('/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              member: memberSelect.value,
              persist: persistToggle.checked,
            }),
          });

          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to start session');

          currentSessionId = data.sessionId;
          appendSystemBanner(data);

          if (data.greeting) {
            appendMessage('assistant', data.greeting);
          }

          setStatus('ready', 'Ready');
          userInput.disabled = false;
          sendButton.disabled = false;
          userInput.focus();
        } catch (err) {
          setStatus('error', 'Error');
          appendCallEnded('Initialization error: ' + err.message);
        } finally {
          isBusy = false;
        }
      }

      async function sendMessage() {
        const text = userInput.value.trim();
        if (!text || isBusy || isCallEnded || !currentSessionId) return;

        isBusy = true;
        userInput.disabled = true;
        sendButton.disabled = true;
        setStatus('busy', 'Thinking...');

        appendMessage('user', text);
        userInput.value = '';

        try {
          const res = await fetch('/api/turn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: currentSessionId,
              message: text,
              persist: persistToggle.checked,
            }),
          });

          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Turn failed');

          if (Array.isArray(data.toolCalls)) {
            data.toolCalls.forEach(appendToolCall);
          }

          if (data.agentReply) {
            appendMessage('assistant', data.agentReply);
          }

          if (data.ended) {
            isCallEnded = true;
            appendCallEnded('Session finished (Call ended by model or handoff triggered)');
            setStatus('ended', 'Ended');
          } else {
            setStatus('ready', 'Ready');
          }
        } catch (err) {
          setStatus('error', 'Error');
          appendCallEnded('Error: ' + err.message);
        } finally {
          isBusy = false;
          if (!isCallEnded) {
            userInput.disabled = false;
            sendButton.disabled = false;
            userInput.focus();
          }
        }
      }

      chatForm.addEventListener('submit', function (e) {
        e.preventDefault();
        sendMessage();
      });

      userInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      resetButton.addEventListener('click', initSession);
      memberSelect.addEventListener('change', initSession);
      persistToggle.addEventListener('change', function () {
        // Updated state will be picked up on next message
      });

      // Initial startup
      initSession();
    })();
  </script>
</body>
</html>
`;
}

export function parsePort(argv: string[]): number {
  const flag = argv.indexOf('--port');
  const value = flag === -1 ? undefined : Number(argv[flag + 1]);
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_WEB_TESTER_PORT;
}

export function startWebTesterServer(port: number = DEFAULT_WEB_TESTER_PORT): Server {
  const env = loadEnv();
  const app = createWebTesterApp({
    apiKey: env.OPENAI_API_KEY,
    databaseUrl: env.DATABASE_URL,
  });

  const server = app.listen(port, '127.0.0.1', () => {
    process.stdout.write(
      '\\nTechMirai Voice — Web Text Tester\\n' +
        `  Local URL: http://127.0.0.1:${port}\\n` +
        `  Model:     ${OPENAI_MODEL} (OpenAI)\\n` +
        '  Ready for manual browser testing. Press Ctrl+C to stop.\\n\\n',
    );
  });

  return server;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const port = parsePort(process.argv.slice(2));
  startWebTesterServer(port);
}
