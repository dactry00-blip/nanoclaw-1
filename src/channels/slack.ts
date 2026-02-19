import { App } from '@slack/bolt';

import { ASSISTANT_NAME, SLACK_BOT_TOKEN, SLACK_APP_TOKEN } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata } from '../types.js';


export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, import('../types.js').RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private connected = false;
  private botUserId = '';
  private botToken: string;
  private opts: SlackChannelOpts;
  private userNameCache = new Map<string, { name: string; cachedAt: number }>();
  private static USER_CACHE_TTL = 60 * 60 * 1000; // 1 hour
  private typingMessages = new Map<string, string>(); // channel → message ts

  constructor(opts: SlackChannelOpts) {
    logger.info('[SLACK] Constructor called');

    if (!SLACK_BOT_TOKEN) logger.warn('[SLACK] SLACK_BOT_TOKEN is not set in .env or environment');
    if (!SLACK_APP_TOKEN) logger.warn('[SLACK] SLACK_APP_TOKEN is not set in .env or environment');
    if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
      throw new Error('Slack tokens missing — set SLACK_BOT_TOKEN and SLACK_APP_TOKEN in .env');
    }

    this.botToken = SLACK_BOT_TOKEN;
    this.opts = opts;
    this.app = new App({
      token: SLACK_BOT_TOKEN,
      appToken: SLACK_APP_TOKEN,
      socketMode: true,
      logLevel: undefined,
    });

    this.setupListeners();
  }

  private handleEvent(event: { text?: string; channel: string; user?: string; ts: string }): void {
    logger.info({ event }, 'Slack raw event received');
    if (!event.text) return;

    const text = event.text;
    const channel = event.channel;
    const sender = event.user || '';
    const timestamp = event.ts;

    const isoTimestamp = new Date(parseFloat(timestamp) * 1000).toISOString();

    this.opts.onChatMetadata(channel, isoTimestamp, channel);

    const groups = this.opts.registeredGroups();
    if (!groups[channel]) return;

    const isBotMessage = sender === this.botUserId;

    // Use cached name or sender ID immediately — don't block message storage
    const cached = this.userNameCache.get(sender);
    const senderName = (cached && Date.now() - cached.cachedAt < SlackChannel.USER_CACHE_TTL)
      ? cached.name
      : sender;

    // Store message immediately (no waiting for API)
    this.opts.onMessage(channel, {
      id: timestamp,
      chat_jid: channel,
      sender,
      sender_name: senderName,
      content: text,
      timestamp: isoTimestamp,
      is_from_me: isBotMessage,
      is_bot_message: isBotMessage,
    });

    // Resolve user name in background for future messages
    if (!cached || Date.now() - cached.cachedAt >= SlackChannel.USER_CACHE_TTL) {
      this.app.client.users.info({ token: this.botToken, user: sender })
        .then((info) => {
          const resolvedName = info.user?.real_name || info.user?.name || sender;
          this.userNameCache.set(sender, { name: resolvedName, cachedAt: Date.now() });
        })
        .catch(() => { logger.debug({ sender }, 'Failed to resolve Slack user name'); });
    }
  }

  private setupListeners(): void {
    logger.info('[SLACK] Setting up event listeners');

    // Listen for direct messages and channel messages
    this.app.event('message', async ({ event }) => {
      logger.info({ event: JSON.stringify(event).slice(0, 500) }, '[SLACK] Received "message" event');
      // Skip bot's own messages and message subtypes (edits, deletions, etc.)
      if (
        !('text' in event) ||
        !event.text ||
        ('subtype' in event && event.subtype)
      ) {
        logger.info('[SLACK] Skipping message event (no text or has subtype)');
        return;
      }

      this.handleEvent(event as { text: string; channel: string; user?: string; ts: string });
    });

    // Listen for @mentions of the bot
    this.app.event('app_mention', async ({ event }) => {
      logger.info({ event: JSON.stringify(event).slice(0, 500) }, '[SLACK] Received "app_mention" event');
      this.handleEvent(event as { text: string; channel: string; user?: string; ts: string });
    });
  }

  async connect(): Promise<void> {
    logger.info('[SLACK] connect() called, starting app...');
    const startResult = await this.app.start();
    logger.info({ startResult }, '[SLACK] app.start() returned');
    this.connected = true;

    // Fetch bot's own user ID to detect self-messages
    try {
      const auth = await this.app.client.auth.test({ token: this.botToken });
      this.botUserId = auth.user_id || '';
      logger.info('Slack Socket Mode connected');
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch bot user ID');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const prefixed = `${ASSISTANT_NAME}: ${text}`;
    try {
      await this.app.client.chat.postMessage({
        token: this.botToken,
        channel: jid,
        text: prefixed,
      });
      logger.info({ channel: jid, length: prefixed.length }, 'Slack message sent');
    } catch (err) {
      logger.error({ channel: jid, err }, 'Failed to send Slack message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // Slack channel IDs start with C (channels), D (DMs), or G (group DMs)
    return /^[CDG]/.test(jid);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      if (isTyping) {
        // Post a temporary "thinking" message
        if (!this.typingMessages.has(jid)) {
          const res = await this.app.client.chat.postMessage({
            token: this.botToken,
            channel: jid,
            text: `${ASSISTANT_NAME}: _thinking..._`,
          });
          if (res.ts) {
            this.typingMessages.set(jid, res.ts);
          }
        }
      } else {
        // Delete the temporary message
        const ts = this.typingMessages.get(jid);
        if (ts) {
          this.typingMessages.delete(jid);
          await this.app.client.chat.delete({
            token: this.botToken,
            channel: jid,
            ts,
          }).catch(() => { /* message may already be gone */ });
        }
      }
    } catch (err) {
      logger.debug({ channel: jid, err }, 'Typing indicator error');
    }
  }
}
