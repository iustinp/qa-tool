/**
 * Bedrock Runtime Converse via native fetch + Bearer token.
 * Avoids @aws-sdk/client-bedrock-runtime auth issues with API keys in some environments.
 */

/**
 * @param {object} params
 * @param {string} params.region
 * @param {string} params.modelId
 * @param {Array<{role:string, content: unknown[]}>} params.messages - Bedrock Converse message shape (JSON-serializable)
 * @param {{ maxTokens?: number }} [params.inferenceConfig]
 * @param {Array<{ text: string }>} [params.system]
 * @returns {Promise<object>} Parsed Converse JSON response
 */
async function bedrockConverseFetch(params) {
  const { region, modelId, messages, inferenceConfig, system } = params;
  const token = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!token) {
    throw new Error('AWS_BEARER_TOKEN_BEDROCK is required for Bedrock fetch');
  }

  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;

  const body = {
    ...(inferenceConfig && Object.keys(inferenceConfig).length > 0
      ? { inferenceConfig }
      : {}),
    messages,
    ...(system && system.length > 0 ? { system } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Bedrock API error ${res.status}: ${errText.slice(0, 800)}`);
  }

  return res.json();
}

module.exports = { bedrockConverseFetch };
