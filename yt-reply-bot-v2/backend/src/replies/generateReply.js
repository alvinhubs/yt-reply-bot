const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { buildSystemPrompt } = require('./stylePrompt');

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * Generates one reply for one top-level comment.
 * `videoTitle` is passed in as light context (helps the model not reply as
 * if every comment is about the most recent video in general).
 */
async function generateReply({ commentText, videoTitle }) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    system: buildSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: `Video: "${videoTitle || 'unknown'}"\nComment: "${commentText}"\n\nWrite the reply. Output only the reply text, nothing else — no quotes, no preamble.`,
      },
    ],
  });

  const text = msg.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  return text;
}

module.exports = { generateReply };
