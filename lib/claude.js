const Anthropic = require('@anthropic-ai/sdk');
const { extractJsonObject } = require('./json-extract');
const { bedrockConverseFetch } = require('./bedrock-converse-fetch');

let useBedrock = false;
/** Bedrock API key path: native fetch to .../converse */
let useBedrockConverse = false;
let bedrockClient = null;
let bedrockRegion = 'us-east-2';
let anthropicClient = null;
let claudeModel = null;

/**
 * Anthropic-style content → Bedrock Converse `messages[].content` (JSON-safe for fetch).
 * Image `bytes` must be base64 string for REST JSON.
 */
function anthropicContentToFetchConverseBlocks(content) {
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const b of content) {
    if (b.type === 'text' && b.text) {
      blocks.push({ text: b.text });
    } else if (b.type === 'image' && b.source?.type === 'base64' && b.source.data) {
      const mt = b.source.media_type || 'image/png';
      let format = 'png';
      if (mt.includes('jpeg') || mt.includes('jpg')) format = 'jpeg';
      else if (mt.includes('webp')) format = 'webp';
      else if (mt.includes('gif')) format = 'gif';
      blocks.push({
        image: {
          format,
          source: { bytes: b.source.data },
        },
      });
    }
    // Anthropic cache_control on a block => a Converse cachePoint *after* it
    // (marks the end of the cacheable prefix).
    if (b.cache_control) {
      blocks.push({ cachePoint: { type: 'default' } });
    }
  }
  return blocks;
}

function anthropicMessagesToFetchConverse(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: anthropicContentToFetchConverseBlocks(m.content),
  }));
}

function converseResponseToAnthropicShape(res) {
  const out = res.output;
  const message =
    out && typeof out === 'object' && 'message' in out ? out.message : null;
  const rawBlocks = message?.content || [];
  const content = [];
  for (const block of rawBlocks) {
    if (block.text != null && block.text !== '') {
      content.push({ type: 'text', text: block.text });
    }
  }
  const u = res.usage;
  const usage =
    u &&
    u.inputTokens != null &&
    u.outputTokens != null &&
    ({
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      cache_read_input_tokens: u.cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: u.cacheWriteInputTokens ?? 0,
    });
  return { content, usage };
}

async function initializeClaudeClient() {
  const bearer = process.env.AWS_BEARER_TOKEN_BEDROCK;
  useBedrock =
    process.env.CLAUDE_CODE_USE_BEDROCK === '1' || Boolean(bearer);
  useBedrockConverse = Boolean(bearer);
  bedrockRegion = process.env.AWS_REGION || 'us-east-2';

  if (useBedrock) {
    claudeModel =
      process.env.ANTHROPIC_MODEL ||
      'global.anthropic.claude-opus-4-5-20251101-v1:0';

    if (bearer) {
      bedrockClient = null;
      return { isBedrock: true, model: claudeModel, auth: 'fetch+converse+bearer' };
    }

    const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
    bedrockClient = new BedrockRuntimeClient({ region: bedrockRegion });
    return { isBedrock: true, model: claudeModel, auth: 'sdk+InvokeModel (IAM)' };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Set ANTHROPIC_API_KEY (direct API), or AWS_BEARER_TOKEN_BEDROCK + AWS_REGION (Bedrock API key), or CLAUDE_CODE_USE_BEDROCK=1 with AWS credentials'
    );
  }
  anthropicClient = new Anthropic.default();
  claudeModel = process.env.ANTHROPIC_MODEL || 'claude-opus-4-5-20251101';
  return { isBedrock: false, model: claudeModel };
}

function imageBlock(base64Png, mediaType = 'image/png', opts = {}) {
  const block = {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: base64Png },
  };
  if (opts.cache) block.cache_control = { type: 'ephemeral' };
  return block;
}

function textBlock(text, opts = {}) {
  const block = { type: 'text', text };
  if (opts.cache) block.cache_control = { type: 'ephemeral' };
  return block;
}

async function callClaudeMessages(messages, maxTokens = 4096) {
  if (useBedrock && useBedrockConverse) {
    const data = await bedrockConverseFetch({
      region: bedrockRegion,
      modelId: claudeModel,
      messages: anthropicMessagesToFetchConverse(messages),
      inferenceConfig: { maxTokens },
    });
    return converseResponseToAnthropicShape(data);
  }

  if (useBedrock && bedrockClient) {
    const { InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: maxTokens,
      messages,
    };
    const command = new InvokeModelCommand({
      modelId: claudeModel,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(requestBody),
    });
    const bedrockResponse = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
    return {
      content: responseBody.content,
      usage: responseBody.usage,
    };
  }

  return anthropicClient.messages.create({
    model: claudeModel,
    max_tokens: maxTokens,
    messages,
  });
}

function firstTextContent(response) {
  const parts = response.content || [];
  for (const p of parts) {
    if (p.type === 'text') return p.text;
  }
  return '';
}

/**
 * userParts: [{ type: 'image_buffer', buffer: Buffer }, { type: 'text', text: string }]
 */
async function visionJson(userParts, maxTokens = 4096) {
  const content = userParts.map((p) => {
    if (p.type === 'image_buffer') {
      return imageBlock(p.buffer.toString('base64'), p.mediaType || 'image/png', { cache: p.cache });
    }
    if (p.type === 'text') return textBlock(p.text, { cache: p.cache });
    throw new Error(`Unknown vision part: ${p.type}`);
  });

  const messages = [{ role: 'user', content }];
  const response = await callClaudeMessages(messages, maxTokens);
  const text = firstTextContent(response);
  return { parsed: extractJsonObject(text), rawText: text, usage: response.usage };
}

async function probeBedrockAuth() {
  const bearer = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!bearer) {
    return {
      ok: false,
      message: 'AWS_BEARER_TOKEN_BEDROCK is not set',
      hint: null,
    };
  }
  await initializeClaudeClient();
  if (!useBedrock || !useBedrockConverse) {
    return {
      ok: false,
      message:
        'Probe expects Bedrock API key auth (AWS_BEARER_TOKEN_BEDROCK set, CLAUDE_CODE_USE_BEDROCK optional)',
      hint: null,
    };
  }
  try {
    await callClaudeMessages(
      [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Reply with only the letter A.' }],
        },
      ],
      32
    );
    return {
      ok: true,
      message: `region=${bedrockRegion} model=${claudeModel} tokenLen=${bearer.length} (fetch+converse)`,
      hint: null,
    };
  } catch (e) {
    const msg = e.message || String(e);
    return {
      ok: false,
      message: msg,
      hint:
        'Check tools/page-pair-diff/.env: AWS_BEARER_TOKEN_BEDROCK, AWS_REGION, and ANTHROPIC_MODEL. Run node index.js --probe-bedrock.',
    };
  }
}

module.exports = {
  initializeClaudeClient,
  probeBedrockAuth,
  visionJson,
  callClaudeMessages,
  imageBlock,
  textBlock,
  firstTextContent,
  extractJsonObject,
};
