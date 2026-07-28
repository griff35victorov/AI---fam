import { AiProvider } from "./provider.js";

const defaultFallbackStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const fallbackErrorCodes = new Set(["AI_TIMEOUT", "AI_NETWORK"]);

function normalizeRoute(route) {
  if (Array.isArray(route)) {
    return route.map((provider) => String(provider).trim()).filter(Boolean);
  }

  if (typeof route === "string") {
    return route
      .split(",")
      .map((provider) => provider.trim())
      .filter(Boolean);
  }

  return [];
}

function canFallback(error) {
  if (fallbackErrorCodes.has(error?.code)) {
    return true;
  }

  return defaultFallbackStatuses.has(error?.status);
}

export class ProfileRoutingAiProvider extends AiProvider {
  constructor({ providers = {}, routes = {}, defaultRoute = ["timeweb"] } = {}) {
    super();
    this.providers = providers;
    this.routes = routes;
    this.defaultRoute = defaultRoute;
  }

  resolveRoute(modelProfile) {
    const profile = modelProfile?.profile ?? "standard";
    return normalizeRoute(this.routes[profile]).length
      ? normalizeRoute(this.routes[profile])
      : normalizeRoute(this.routes.default).length
        ? normalizeRoute(this.routes.default)
        : normalizeRoute(this.defaultRoute);
  }

  async complete(request) {
    const route = this.resolveRoute(request?.modelProfile);
    const errors = [];

    for (const providerName of route) {
      const provider = this.providers[providerName];
      if (!provider) {
        continue;
      }

      try {
        return await provider.complete(request);
      } catch (error) {
        errors.push({ providerName, error });
        if (!canFallback(error)) {
          throw error;
        }
      }
    }

    if (errors.length > 0) {
      const last = errors[errors.length - 1];
      const error = new Error(
        `AI provider route failed after ${errors.map((item) => item.providerName).join(" -> ")}`,
        { cause: last.error },
      );
      error.errors = errors;
      throw error;
    }

    throw new Error(`No AI provider configured for route: ${route.join(" -> ") || "empty"}`);
  }
}
