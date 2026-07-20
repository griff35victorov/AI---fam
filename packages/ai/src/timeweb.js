import { AiProvider } from "./provider.js";

export class TimewebAiProvider extends AiProvider {
  constructor({ baseUrl, apiKey, fetchImpl = fetch }) {
    super();
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async complete({ agentId, messages, model }) {
    if (!this.apiKey) throw new Error("TIMEWEB_AI_API_KEY is required");
    if (!agentId) throw new Error("Timeweb agentId is required");

    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/cloud-ai/agents/${agentId}/call`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ messages, model }),
    });

    if (!response.ok) {
      throw new Error(`Timeweb AI request failed with ${response.status}`);
    }

    return response.json();
  }
}
