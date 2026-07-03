/**
 * ★ SWAP AI MODEL HERE ONLY ★
 * Change AI_PROVIDER env variable to switch between providers.
 * No other file needs to change.
 * Options: openai | anthropic | gemini | mistral | groq | ollama
 */

//
// ✅ CORRECT
const AI_PROVIDER = process.env.AI_PROVIDER || 'mistral'
console.log("🔑 AI_PROVIDER:", AI_PROVIDER);
console.log("🔑 GROQ_API_KEY:", process.env.GROQ_API_KEY?.slice(0, 10) + "...");

async function callAI({
  systemPrompt,
  userPrompt,
  maxTokens = 2000,
  temperature = 0.3,
}) {
  switch (AI_PROVIDER) {
    case "openai": {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const res = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      return res.choices[0].message.content;
    }

    case "anthropic": {
      const Anthropic = await import("@anthropic-ai/sdk");
      const client = new Anthropic.default({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      const res = await client.messages.create({
        model: process.env.ANTHROPIC_MODEL || "claude-3-haiku-20240307",
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });
      return res.content[0].text;
    }

    case "gemini": {
      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
        systemInstruction: systemPrompt,
      });
      const res = await model.generateContent(userPrompt);
      return res.response.text();
    }

    case "mistral": {
      const { Mistral } = await import("@mistralai/mistralai");
      const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await client.chat.complete(
          {
            model: process.env.MISTRAL_MODEL || "mistral-small-latest",
            maxTokens: maxTokens,
            temperature,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          },
          { fetchOptions: { signal: controller.signal } },
        );
        return res.choices[0].message.content;
      } finally {
        clearTimeout(timeoutId);
      }
    }

    case "groq": {
      const Groq = await import("groq-sdk");
      console.log(
        "Using GROQ key:",
        process.env.GROQ_API_KEY?.slice(0, 10) + "...",
      );
      const client = new Groq.default({ apiKey: process.env.GROQ_API_KEY });
      const res = await client.chat.completions.create({
        model: process.env.GROQ_MODEL || "llama3-8b-8192",
        max_tokens: maxTokens,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      return res.choices[0].message.content;
    }

    case "ollama": {
      const res = await fetch(
        `${process.env.OLLAMA_BASE_URL || "http://localhost:11434"}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: process.env.OLLAMA_MODEL || "llama3",
            stream: false,
            options: { temperature },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          }),
        },
      );
      const data = await res.json();
      return data.message.content;
    }

    default:
      throw new Error(
        `Unknown AI_PROVIDER: ${AI_PROVIDER}. Valid options: openai | anthropic | gemini | mistral | groq | ollama`,
      );
  }
}

// Retry wrapper with exponential backoff
async function callAIWithRetry(params, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await callAI(params);
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(
        `AI call failed (attempt ${attempt}/${retries}): ${err.message}`,
      );
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
}

// JSON-safe wrapper — strips markdown fences before JSON.parse
async function callAIForJSON(params) {
  const raw = await callAIWithRetry(params);
  const cleaned = raw
    .replace(/^```json\s*/im, "")
    .replace(/^```\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("AI returned non-JSON:", cleaned);
    throw new Error(
      "AI response was not valid JSON. Raw: " + cleaned.slice(0, 300),
    );
  }
}

module.exports = { callAI, callAIWithRetry, callAIForJSON };
