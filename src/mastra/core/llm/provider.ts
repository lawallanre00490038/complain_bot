import "dotenv/config";
import { fastembed } from '@mastra/fastembed';
import { embedMany } from 'ai';
import { createOpenAI, openai } from "@ai-sdk/openai";


const apiVersion =
  process.env.AZURE_OPENAI_API_VERSION?.trim() || "2024-08-01-preview";

const resourceName =
  process.env.AZURE_RESOURCE_NAME ||
  process.env.AZURE_OPENAI_ENDPOINT?.match(/https?:\/\/([^.]+)\.openai\.azure\.com/)?.[1];

const azureConfigured = !!resourceName && !!process.env.AZURE_OPENAI_API_KEY;

// Singleton — build once, reuse everywhere
const providers = new Map<string, ReturnType<typeof createOpenAI>>();

function getAzureProvider(deployment: string): ReturnType<typeof createOpenAI> {
  if (providers.has(deployment)) {
    return providers.get(deployment)!;
  }

  const baseURL =
    `https://${resourceName}.openai.azure.com/openai/deployments/${deployment}`;

  const provider = createOpenAI({
    baseURL,
    apiKey: process.env.AZURE_OPENAI_API_KEY!,
    fetch(url, init) {
      const u = new URL(
        typeof url === "string"
          ? url
          : url instanceof URL
          ? url.href
          : (url as Request).url
      );

      u.searchParams.set("api-version", apiVersion);

      return globalThis.fetch(u.toString(), init);
    },
  });

  providers.set(deployment, provider);

  return provider;
}


export function getChatModel(modelName = process.env.OPENAI_MODEL || "gpt-4o-mini") {
  if (azureConfigured) {
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_DEPLOYMENT_NAME || modelName;
    console.log(`\n\nUsing Azure OpenAI (deployment path) — resource: ${resourceName}, deployment: ${deployment}, api-version: ${apiVersion}`);
    return getAzureProvider(deployment).chat(deployment);
  }

  console.log(`\n\nUsing OpenAI provider with model: ${modelName}`);
  return openai(modelName);
}

// export function getEmbeddingModel(modelName = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small") {
//   if (azureConfigured) {
//     const deployment = process.env.AZURE_OPENAI_EMBEDDING_MODEL || modelName;
//     return getAzureProvider(deployment).embedding(deployment);
//   }

//   return openai.embedding(modelName);
// }



export function getEmbeddingModel() {
  return fastembed.base;
}

/**
 * Pre-warms the FastEmbed ONNX model so the first real upload
 * does not pay the cold-start penalty (model download + load).
 */
export async function warmUpEmbeddingModel() {
  try {
    console.log("[RAG] Warming up FastEmbed model...");
    await embedMany({ model: getEmbeddingModel(), values: ["warm up"] });
    console.log("[RAG] FastEmbed model ready.");
  } catch (e) {
    // Non-fatal — server still starts, first request will just be slower
    console.warn("[RAG] Embedding warm-up failed (non-fatal):", e);
  }
}
