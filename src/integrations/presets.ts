import type { WebhookPreset } from '../schemas/webhook.schema.js';
import type { Message } from './message.js';

/**
 * T3.3: one Message in the shape each product accepts. Pure. Each product has its own markup, and every string that came from a run
 * is escaped for it, so a page that prints `<script>` or `@channel` cannot do anything in the channel.
 *
 *   generic    plain JSON for anything else (a script, Zapier, n8n)
 *   slack      incoming webhook: { text } with mrkdwn
 *   googlechat incoming webhook: { text } (its own *bold* markup)
 *   teams      Workflows webhook ("When a Teams webhook request is received"): a message with an Adaptive Card attachment
 */

const MARKS: Record<Message['severity'], string> = { bad: '[FAILING]', good: '[OK]', info: '[INFO]' };

/** Slack mrkdwn: & < > must be entities, and a mention such as <!channel> can only be written with the angle brackets, so escaping them disarms it. */
const slackEscape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Google Chat: *bold*, _italic_, ~strike~, `code` and <users/all> mentions. Neutralize the markers and the angle brackets. */
const chatEscape = (text: string): string => text.replace(/[*_~`]/g, (char) => `\\${char}`).replace(/</g, '‹').replace(/>/g, '›');

function lines(message: Message, bold: (text: string) => string, escape: (text: string) => string): string {
  const out = [`${MARKS[message.severity]} ${bold(escape(message.title))}`];
  if (message.text) out.push(escape(message.text));
  for (const field of message.fields) {
    const [first = '', ...rest] = escape(field.value).split('\n');
    out.push(`${bold(escape(field.name))}: ${first}`, ...rest);
  }
  return out.join('\n');
}

export function renderPayload(preset: WebhookPreset, message: Message): Record<string, unknown> {
  switch (preset) {
    case 'generic':
      return {
        source: 'scrapforai',
        version: 1,
        event: message.kind,
        severity: message.severity,
        title: message.title,
        text: message.text,
        at: message.at,
        ...(message.subject ? { subject: message.subject } : {}),
        fields: message.fields,
      };
    case 'slack':
      return { text: lines(message, (text) => `*${text}*`, slackEscape) };
    case 'googlechat':
      return { text: lines(message, (text) => `*${text}*`, chatEscape) };
    case 'teams':
      return {
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            contentUrl: null,
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                { type: 'TextBlock', text: `${MARKS[message.severity]} ${message.title}`, weight: 'Bolder', size: 'Medium', wrap: true, color: message.severity === 'bad' ? 'Attention' : message.severity === 'good' ? 'Good' : 'Default' },
                ...(message.text ? [{ type: 'TextBlock', text: message.text, wrap: true }] : []),
                ...(message.fields.length > 0 ? [{ type: 'FactSet', facts: message.fields.map((field) => ({ title: field.name, value: field.value })) }] : []),
              ],
            },
          },
        ],
      };
  }
}
