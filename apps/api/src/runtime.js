import { handleOrchestratorRequest } from "./orchestrator.js";
import { runSupervisorTick } from "./supervisor-runner.js";
import {
  analyzeSupervisorState,
  canStoreMemory,
  formatSupervisorReport,
} from "../../../packages/domain/src/index.js";
import {
  buildAllowedMemoryContext,
  dedupeMemoriesBySemanticContent,
  memorySemanticKey,
} from "./context.js";
import {
  buildCapabilitiesAnswer,
  buildMissingCapabilityAnswer,
  buildMissingCurrentDataCapabilityAnswer,
  createCapabilityRegistry,
  detectRequiredCapability,
  extractUrls,
  isTimeLocationRequest,
  isMapLocationRequest,
  isMapReferenceRequest,
  isTravelLocalRequest,
  isCurrentDataRequest,
  isNewsCurrentDataRequest,
  isWebFetchRequest,
  isWindyWeatherRequest,
  parseMapLocationRequest,
  parseMapReferenceRequest,
  isWeatherRequest,
  parseLocationLookupRequest,
  parseWindyRequest,
  parseWeatherRequest,
} from "./capabilities.js";

const defaultAnswer = "Принял. Задача обработана.";
const memoryContextLimit = 20;
const materialContextLimit = 4;
const recentConversationLookupLimit = 16;
const diagnosticsLookupLimit = 24;
const slowResponseThresholdMs = 8000;
const telegramSafeAnswerLimit = 3900;
const memoryProfileContextLimit = 40;
const memoryRecentCandidateLimit = 80;
const memoryProfileSummaryLimit = 3;
const memorySearchLimit = 8;

function conversationIdForRequest(request) {
  return request.conversationId ?? `telegram:${request.chatId}:${request.actor.id}`;
}

function workspaceIdForRequest(request, fallbackWorkspaceId) {
  return request.actor.workspaceId ?? request.workspaceId ?? fallbackWorkspaceId;
}

function sameTelegramUpdate(message, telegramUpdateId, metadataKey) {
  return (
    telegramUpdateId != null &&
    String(message.metadata?.[metadataKey]) === String(telegramUpdateId)
  );
}

async function findExistingTelegramExchange(
  repositories,
  conversationId,
  telegramUpdateId,
  { actorUserId, workspaceId } = {},
) {
  if (!repositories.conversations.listMessages) {
    return { userMessage: null, assistantMessage: null, messages: [] };
  }

  const conversationMessages = await repositories.conversations.listMessages(conversationId, {
    limit: recentConversationLookupLimit,
  });
  const contextMessages = repositories.conversations.listRecentForActor
    ? await repositories.conversations.listRecentForActor({
        actorUserId,
        workspaceId,
        limit: recentConversationLookupLimit,
      })
    : conversationMessages;

  if (telegramUpdateId == null) {
    return { userMessage: null, assistantMessage: null, messages: contextMessages };
  }

  return {
    messages: contextMessages,
    userMessage:
      conversationMessages.find(
        (message) =>
          message.role === "user" &&
          sameTelegramUpdate(message, telegramUpdateId, "telegramUpdateId"),
      ) ?? null,
    assistantMessage:
      conversationMessages.find(
        (message) =>
          message.role === "assistant" &&
          sameTelegramUpdate(message, telegramUpdateId, "replyToTelegramUpdateId"),
      ) ?? null,
  };
}

function memoryScopeForActor(actor) {
  if (actor?.role === "teacher") return "teacher_private";
  if (actor?.role === "family_child") return "child_learning";
  return "family";
}

function materialScopeForActor(actor) {
  if (actor?.role === "teacher") return "teacher_private";
  if (actor?.role === "family_child") return "child_learning";
  return "family";
}

function canStoreMaterial(actor) {
  return actor?.role === "teacher" || actor?.role === "owner" || actor?.role === "family_child";
}

function extractExplicitMemory(text) {
  const normalized = String(text ?? "").trim();
  const match = normalized.match(/^(?:запомни|сохрани|запиши)\s*,?\s*(?:что\s+)?(.+)$/i);
  const content = match?.[1]?.trim();
  return content ? content.replace(/[.!?]+$/g, "").trim() : null;
}

function normalizeText(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[?!.,]+$/g, "")
    .replace(/^\/([a-z][\w-]*)(?:@\w+)$/i, "/$1");
}

function isMemoryRecallRequest(text) {
  const normalized = normalizeText(text);
  return (
    normalized.includes("что ты помнишь") ||
    normalized.includes("что помнишь") ||
    normalized.includes("что ты запомнил") ||
    normalized.includes("что запомнил")
  );
}

function buildMemoryRecallAnswer({ actor, memories }) {
  const allowedMemories = buildAllowedMemoryContext({
    actor,
    memories,
    action: "read",
  });

  if (allowedMemories.length === 0) {
    return "Пока я ничего не сохранил в твою память. Можно написать: «Запомни, что я люблю короткие ответы».";
  }

  const lines = allowedMemories
    .slice(-8)
    .map((memory) => `- ${memory.content}`);

  return [
    "Вот что я сейчас помню:",
    ...lines,
    "Чтобы добавить новый факт, напиши: «Запомни, что ...».",
  ].join("\n");
}

function memoryContentForDisplay(memory) {
  return String(memory.summary ?? memory.content ?? "").trim();
}

function buildMemoryProfileAnswer({ actor, memories }) {
  const allowedMemories = dedupeMemoriesBySemanticContent(buildAllowedMemoryContext({
    actor,
    memories,
    action: "read",
  })).filter((memory) => memoryContentForDisplay(memory));

  if (allowedMemories.length === 0) {
    return [
      "Профиль памяти пока пуст.",
      "Можно обучать меня обычными фразами или командами: «Запомни, что ...», «/learn fact ...», «/learn material ...».",
    ].join("\n");
  }

  const profileSummaries = allowedMemories.filter(
    (memory) => memory.subjectType === "profile_summary",
  );
  const regularMemories = allowedMemories.filter(
    (memory) => memory.subjectType !== "profile_summary",
  );
  const lines = [
    "Профиль памяти, который сейчас использует оркестр:",
    "",
  ];

  if (profileSummaries.length > 0) {
    lines.push("Сводка:");
    lines.push(...profileSummaries.slice(-2).map((memory) => `- ${memoryContentForDisplay(memory)}`));
    lines.push("");
  }

  lines.push("Факты:");
  lines.push(
    ...regularMemories
      .slice(-12)
      .map((memory) => `- [${memory.scope}/${memory.subjectType}] ${memoryContentForDisplay(memory)}`),
  );

  return lines.join("\n");
}

function buildConsolidatedMemoryText({ actor, memories }) {
  const allowedMemories = dedupeMemoriesBySemanticContent(buildAllowedMemoryContext({
    actor,
    memories,
    action: "read",
  }))
    .filter((memory) => memory.subjectType !== "profile_summary")
    .map(memoryContentForDisplay)
    .filter(Boolean);

  if (allowedMemories.length === 0) return "";

  const roleLabel =
    actor?.role === "teacher"
      ? "Профиль преподавателя"
      : actor?.role === "family_child"
        ? "Учебный профиль"
        : "Семейный профиль";

  return [
    `${roleLabel}:`,
    ...allowedMemories
      .slice(-16)
      .map((content) => `- ${content}`),
  ].join("\n");
}

function memoryRecordKey(memory) {
  return memorySemanticKey(memory);
}

function mergeMemoryLists(lists, limit = memoryContextLimit) {
  const seen = new Set();
  const merged = [];

  for (const list of lists) {
    for (const memory of list ?? []) {
      const key = memoryRecordKey(memory);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(memory);
      if (merged.length >= limit) return merged;
    }
  }

  return merged;
}

async function loadProfileSummaryMemories({
  repositories,
  actor,
  workspaceId,
  limit = memoryProfileSummaryLimit,
}) {
  if (!repositories.memories) return [];

  if (repositories.memories.listBySubject) {
    return repositories.memories.listBySubject({
      actorUserId: actor.id,
      workspaceId,
      subjectType: "profile_summary",
      subjectId: actor.id,
      limit,
    });
  }

  if (!repositories.memories.listForActor) return [];
  const memories = await repositories.memories.listForActor({
    actorUserId: actor.id,
    workspaceId,
    limit: Math.max(limit, memoryProfileContextLimit),
  });

  return memories
    .filter((memory) =>
      memory.subjectType === "profile_summary" &&
      (memory.subjectId ?? actor.id) === actor.id,
    )
    .slice(-limit);
}

async function loadMemoryProfileMemories({
  repositories,
  actor,
  workspaceId,
  fallbackMemories = [],
}) {
  if (!repositories.memories) {
    return mergeMemoryLists([fallbackMemories], memoryProfileContextLimit);
  }

  const [profileSummaries, recentMemories] = await Promise.all([
    loadProfileSummaryMemories({
      repositories,
      actor,
      workspaceId,
      limit: memoryProfileSummaryLimit,
    }),
    repositories.memories.listForActor
      ? repositories.memories.listForActor({
          actorUserId: actor.id,
          workspaceId,
          limit: memoryProfileContextLimit,
        })
      : [],
  ]);

  return mergeMemoryLists(
    [profileSummaries, recentMemories, fallbackMemories],
    memoryProfileContextLimit,
  );
}

async function loadRelevantMemories({
  repositories,
  actor,
  workspaceId,
  text,
  fallbackMemories = [],
}) {
  if (!repositories.memories) {
    return mergeMemoryLists([fallbackMemories], memoryContextLimit);
  }

  const [profileSummaries, searchedMemories, recentMemories] = await Promise.all([
    loadProfileSummaryMemories({
      repositories,
      actor,
      workspaceId,
      limit: memoryProfileSummaryLimit,
    }),
    repositories.memories.search
      ? repositories.memories.search({
          actorUserId: actor.id,
          workspaceId,
          query: text,
          limit: memorySearchLimit,
        })
      : [],
    repositories.memories.listForActor
      ? repositories.memories.listForActor({
          actorUserId: actor.id,
          workspaceId,
          limit: memoryContextLimit,
        })
      : [],
  ]);

  return mergeMemoryLists(
    [profileSummaries, searchedMemories, fallbackMemories, recentMemories],
    memoryContextLimit,
  );
}

async function upsertMemoryProfileSummary({
  repositories,
  actor,
  workspaceId,
  memories,
  sourceMessageIds = [],
}) {
  if (!repositories.memories?.upsertSummary) return null;

  const consolidatedText = buildConsolidatedMemoryText({ actor, memories });
  if (!consolidatedText) return null;

  try {
    return await repositories.memories.upsertSummary({
      workspaceId,
      ownerUserId: actor.id,
      scope: memoryScopeForActor(actor),
      sensitivity: "normal",
      subjectType: "profile_summary",
      subjectId: actor.id,
      content: consolidatedText,
      summary: consolidatedText,
      confidence: 0.82,
      sourceMessageIds,
    });
  } catch (error) {
    console.error("memory profile summary upsert failed", error);
    return null;
  }
}

function isMemoryProfileRequest(text) {
  const normalized = normalizeText(text);
  return (
    normalized === "/memory" ||
    normalized === "/memory profile" ||
    normalized === "/profile" ||
    normalized === "профиль памяти" ||
    normalized === "что ты знаешь обо мне" ||
    normalized === "что ты знаешь о семье" ||
    normalized.includes("покажи профиль памяти")
  );
}

function isMemoryConsolidationRequest(text) {
  const normalized = normalizeText(text);
  return (
    normalized === "/memory consolidate" ||
    normalized === "/consolidate" ||
    normalized === "собери память" ||
    normalized === "консолидируй память" ||
    normalized.includes("собери профиль памяти") ||
    normalized.includes("обнови профиль памяти")
  );
}

const sensitiveMemoryPatterns = [
  /(?:парол|password|passcode|токен|token|api[-_\s]?key|секрет|secret|ключ доступа|access key)/i,
  /(?:номер карты|банковск(?:ая|ой|ие)? карт|cvv|cvc|паспорт|снилс|инн)/i,
];

function isSensitiveMemoryContent(content) {
  return sensitiveMemoryPatterns.some((pattern) => pattern.test(content));
}

function hasHighRiskSecretShape(content) {
  return (
    /[A-Za-z0-9_-]{32,}/.test(content) ||
    /https?:\/\/\S*(?:token|key|secret|auth|password)\S*/i.test(content)
  );
}

function isUnsafeLongTermContent(content) {
  return isSensitiveMemoryContent(content) || hasHighRiskSecretShape(content);
}

function canonicalMemoryContent(content) {
  return normalizeText(content)
    .replace(/[«»"']/g, "")
    .replace(/\s+/g, " ");
}

function memoryAlreadyExists(memories, content) {
  const canonical = canonicalMemoryContent(content);
  return memories.some((memory) => canonicalMemoryContent(memory.content) === canonical);
}

function recordHasSourceMessageId(record, sourceMessageId) {
  return (
    sourceMessageId != null &&
    Array.isArray(record?.sourceMessageIds) &&
    record.sourceMessageIds.includes(sourceMessageId)
  );
}

function materialAlreadyExists(materials, { title, sourceMessageId } = {}) {
  const canonicalTitle = canonicalMemoryContent(title);
  return materials.some(
    (material) =>
      recordHasSourceMessageId(material, sourceMessageId) ||
      (canonicalTitle && canonicalMemoryContent(material.title) === canonicalTitle),
  );
}

const journalReferencePattern =
  /(?:\u0436\u0443\u0440\u043d\u0430\u043b|journal|magazine)/i;
const siteReferencePattern =
  /(?:\u0441\u0430\u0439\u0442|\u0434\u043e\u043c\u0435\u043d|site|domain)/i;
const stableMemoryDomainReferencePattern =
  /(?:\u0432\s+\u043d(?:\u0435|\u0451)\u043c|\u043d\u0430\s+\u043d(?:\u0435|\u0451)\u043c|\u0442\u0430\u043c|\u043d\u0430\s+\u044d\u0442\u043e\u043c|\u043d\u0430\s+\u0441\u0430\u0439\u0442\u0435|\u043c\u043e(?:\u0435|\u0451)\u043c\s+\u0441\u0430\u0439\u0442\u0435|\u0432\s+\u0436\u0443\u0440\u043d\u0430\u043b\u0435|\u043c\u043e(?:\u0435|\u0451)\u043c\s+\u0436\u0443\u0440\u043d\u0430\u043b\u0435|on\s+it|there|my\s+site|my\s+journal)/i;

function normalizeMemoryDomain(hostname) {
  const normalized = String(hostname ?? "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");

  if (!/^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function domainsFromMemory(memory) {
  return extractUrls(memory?.content ?? "")
    .map((url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return null;
        }

        return normalizeMemoryDomain(parsed.hostname);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function resolveMemoryDomainHint({ actor, memories, text }) {
  if (!stableMemoryDomainReferencePattern.test(String(text ?? ""))) {
    return null;
  }

  const allowedMemories = buildAllowedMemoryContext({
    actor,
    memories,
    action: "read",
  });
  const domainCandidatesByName = new Map();
  for (const [index, memory] of allowedMemories.entries()) {
    for (const domain of domainsFromMemory(memory)) {
      const score =
        (journalReferencePattern.test(text) && journalReferencePattern.test(memory.content)
          ? 4
          : 0) +
        (siteReferencePattern.test(text) && siteReferencePattern.test(memory.content)
          ? 2
          : 0);
      const previous = domainCandidatesByName.get(domain);
      if (
        !previous ||
        score > previous.score ||
        (score === previous.score && index > previous.index)
      ) {
        domainCandidatesByName.set(domain, {
          domain,
          memory,
          index,
          score,
        });
      }
    }
  }
  const domainCandidates = Array.from(domainCandidatesByName.values());

  if (domainCandidates.length === 0) {
    return null;
  }

  const sorted = domainCandidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.index - left.index;
  });

  if (sorted.length === 1 || sorted[0].score > sorted[1].score) {
    return sorted[0].domain;
  }

  return null;
}

function parseRequestedSearchLimit(text) {
  const match = String(text ?? "").match(/\b([1-9]|[1-4][0-9]|50)\b/);
  if (!match) return null;

  return Math.min(50, Math.max(1, Number(match[1])));
}

function buildWebCurrentDataArgs({ request, memories, workspaceId }) {
  const explicitDomain = extractDomainFromRequestUrls(request.text);
  const memoryDomain = resolveMemoryDomainHint({
    actor: request.actor,
    memories,
    text: request.text,
  });
  const domain = explicitDomain ?? memoryDomain;
  const limit = parseRequestedSearchLimit(request.text);

  return {
    text: request.text,
    query: request.text,
    actor: request.actor,
    workspaceId,
    chatId: request.chatId,
    botKey: request.telegramBotKey,
    ...(domain ? { domain } : {}),
    ...(limit ? { limit } : {}),
  };
}

function extractDomainFromRequestUrls(text) {
  for (const url of extractUrls(text)) {
    try {
      const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
      if (hostname) return hostname;
    } catch {
      // Ignore malformed URLs; extractUrls already filters most of them.
    }
  }

  return null;
}

function shouldSkipAutomaticMemory(text) {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length < 12) return true;
  if (normalized.startsWith("/")) return true;
  if (extractExplicitMemory(text)) return true;
  if (isMemoryRecallRequest(text)) return true;
  if (isDiagnosticsRequest(text)) return true;
  if (isMaterialListRequest(text) || parseMaterialCommand(text)?.matched) return true;
  if (/[?？]$/.test(String(text ?? "").trim())) return true;

  return [
    "статус",
    "проверка",
    "тест",
    "сделай",
    "найди",
    "посчитай",
    "подготовь",
    "нарисуй",
  ].some((prefix) => normalized.startsWith(prefix));
}

function looksLikeStudentPersonalData(sentence) {
  return /(?:ученик|ученица|student|контакт|телефон|родител)/i.test(sentence);
}

function automaticMemorySubjectType(actor, sentence) {
  if (/(?:журнал|проект|сайт|бизнес|канал|бренд|journal|project|site|business|brand)/i.test(sentence)) {
    return "project";
  }

  if (
    actor?.role === "teacher" &&
    /(?:стиль|на уроках|я преподаю|warmup|worksheet|домашн)/i.test(sentence)
  ) {
    return "teaching_style";
  }

  if (actor?.role === "family_child") {
    return "study_preference";
  }

  return "auto_observed_fact";
}

function extractAutomaticMemoryCandidates(text, actor) {
  if (shouldSkipAutomaticMemory(text)) return [];

  const sentences = String(text ?? "")
    .split(/[\n.!?]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  const stableFactPatterns = [
    /(?:я\s+(?:люблю|предпочитаю|обычно|часто|всегда)|мне\s+(?:важно|удобно|нравится))/i,
    /(?:мой|моя|моё|мое|наша|наш|наше)\s+.{2,80}\s+(?:это|называется|—|-|:)/i,
    /(?:мой|моя|моё|мое|наша|наш|наше)\s+.{2,80}\s+(?:is|called)\b/i,
    /\b(?:my|our)\s+.{2,80}\s+(?:is|called)\b/i,
    /(?:я\s+(?:автор|редактор|владелец|основатель|веду|занимаюсь)|i\s+am\s+(?:the\s+)?(?:author|editor|owner|founder))/i,
    /\b(?:i\s+(?:like|prefer|usually|always)|it is important to me)\b/i,
  ];
  const teacherPatterns = [
    /(?:мой стиль|стиль преподавания|на уроках|я преподаю|я обычно на уроках)/i,
    /\b(?:my teaching style|in my lessons|i teach)\b/i,
  ];
  const patterns = actor?.role === "teacher"
    ? [...stableFactPatterns, ...teacherPatterns]
    : stableFactPatterns;

  return sentences
    .filter((sentence) => sentence.length >= 12 && sentence.length <= 240)
    .filter((sentence) => patterns.some((pattern) => pattern.test(sentence)))
    .filter((sentence) => !looksLikeStudentPersonalData(sentence))
    .filter((sentence) => !isUnsafeLongTermContent(sentence))
    .slice(0, 2)
    .map((sentence) => ({
      scope: memoryScopeForActor(actor),
      sensitivity: "normal",
      subjectType: automaticMemorySubjectType(actor, sentence),
      content: sentence.replace(/[.!?]+$/g, "").trim(),
      confidence: 0.74,
    }));
}

async function storeAutomaticMemories({
  repositories,
  request,
  storedUserMessage,
  workspaceId,
  memories,
}) {
  if (!repositories.memories?.create) return [];

  const candidates = extractAutomaticMemoryCandidates(request.text, request.actor)
    .filter((candidate) => !memoryAlreadyExists(memories, candidate.content))
    .map((candidate) => ({
      ...candidate,
      workspaceId,
      ownerUserId: request.actor.id,
      sourceMessageIds: storedUserMessage?.id ? [storedUserMessage.id] : [],
    }))
    .filter((candidate) => canStoreMemory(request.actor, candidate));

  const stored = [];
  for (const candidate of candidates) {
    try {
      const memory = await repositories.memories.create(candidate);
      stored.push(memory);
      memories.push(memory);
    } catch (error) {
      console.error("automatic memory write failed", error);
    }
  }

  return stored;
}

function splitMaterialBody(titleHint, body) {
  const lines = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const title = String(titleHint ?? lines.shift() ?? "").trim();
  const content = lines.join("\n").trim();

  return { title, content };
}

function parseMaterialCommand(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return null;

  const slashMatch = normalized.match(/^\/materials\s+add(?:\s+([^\n]+))?(?:\n([\s\S]+))?$/i);
  if (slashMatch) {
    const parsed = splitMaterialBody(slashMatch[1], slashMatch[2] ?? "");
    return { matched: true, ...parsed };
  }

  const russianMatch =
    normalized.match(/^(?:добавь|сохрани|запиши)\s+материал\s*:?\s*([\s\S]+)$/i) ??
    normalized.match(/^материал\s*:?\s*([\s\S]+)$/i);

  if (!russianMatch) return null;

  return {
    matched: true,
    ...splitMaterialBody(null, russianMatch[1]),
  };
}

function parseLearningCommand(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return null;

  if (/^(?:\/learn|\/teach|обучение|как обучать)$/i.test(normalized)) {
    return { matched: true, type: "help" };
  }

  if (/^(?:\/learn|\/teach)\s+(?:list|список|что выучено)$/i.test(normalized)) {
    return { matched: true, type: "list" };
  }

  const slashMaterialMatch =
    normalized.match(/^\/(?:learn|teach)\s+(?:material|материал)\s+([^\n]+)(?:\n([\s\S]+))?$/i);
  if (slashMaterialMatch) {
    const parsed = splitMaterialBody(slashMaterialMatch[1], slashMaterialMatch[2] ?? "");
    return { matched: true, type: "material", ...parsed };
  }

  const russianMaterialMatch =
    normalized.match(/^обучи\s+(?:материал|библиотек[ау])\s*:?\s*([\s\S]+)$/i);
  if (russianMaterialMatch) {
    const parsed = splitMaterialBody(null, russianMaterialMatch[1]);
    return { matched: true, type: "material", ...parsed };
  }

  const styleMatch =
    normalized.match(/^\/(?:learn|teach)\s+(?:style|стиль)\s+([\s\S]+)$/i) ??
    normalized.match(/^обучи\s+(?:стиль|стилю)\s*:?\s*([\s\S]+)$/i);
  if (styleMatch?.[1]?.trim()) {
    return {
      matched: true,
      type: "memory",
      memoryKind: "style",
      content: styleMatch[1].trim(),
    };
  }

  const memoryMatch =
    normalized.match(/^\/(?:learn|teach)\s+(?:fact|memory|факт|память)\s+([\s\S]+)$/i) ??
    normalized.match(/^обучи\s+(?:агента|бота|оркестратор)?\s*:?\s*([\s\S]+)$/i);
  if (memoryMatch?.[1]?.trim()) {
    return {
      matched: true,
      type: "memory",
      memoryKind: "fact",
      content: memoryMatch[1].trim(),
    };
  }

  return null;
}

export function isImmediateRepositoryBackedRequest(text) {
  return Boolean(
    parseLearningCommand(text) ||
    extractExplicitMemory(text) ||
    isMemoryProfileRequest(text) ||
    isMemoryConsolidationRequest(text) ||
    isMemoryRecallRequest(text) ||
    isDiagnosticsRequest(text) ||
    isCapabilitiesRequest(text) ||
    isWebChatAccessRequest(text) ||
    parseMaterialCommand(text)?.matched ||
    isMaterialListRequest(text),
  );
}

function isUnsafeLearningCommand(learningCommand) {
  if (learningCommand?.type === "memory") {
    return isUnsafeLongTermContent(learningCommand.content ?? "");
  }

  if (learningCommand?.type === "material") {
    return isUnsafeLongTermContent(
      `${learningCommand.title ?? ""}\n${learningCommand.content ?? ""}`,
    );
  }

  return false;
}

function isMaterialListRequest(text) {
  const normalized = normalizeText(text);
  return (
    normalized === "/materials" ||
    normalized === "/materials list" ||
    normalized === "библиотека" ||
    normalized === "материалы" ||
    normalized.includes("что есть в библиотек") ||
    normalized.includes("список материалов")
  );
}

function learningSubjectType(actor, memoryKind) {
  if (memoryKind === "style" && actor?.role === "teacher") return "teaching_style";
  if (memoryKind === "style") return "preference";
  if (actor?.role === "family_child") return "study_preference";
  return "user_stated_fact";
}

function buildLearningHelpAnswer(actor) {
  const scopeLine =
    actor?.role === "teacher"
      ? "У вас обучение сохраняется в личную базу преподавателя: стиль, материалы, уроки."
      : actor?.role === "family_child"
        ? "У тебя обучение сохраняется в учебную память и личную библиотеку."
        : "У вас обучение сохраняется в семейную память и библиотеку.";

  return [
    "Как обучать агентов прямо из Telegram:",
    "",
    "/learn fact Я предпочитаю короткие ответы",
    "/learn style На уроках начинаем со speaking warm-up",
    "/learn material Название материала",
    "Текст материала, упражнения, плана урока или инструкции",
    "/learn list",
    "",
    "Также работает обычная команда: «Запомни, что ...».",
    "Для файлов: отправьте .txt/.md/.csv с подписью /learn material Название.",
    scopeLine,
  ].join("\n");
}

function buildLearningListAnswer({ actor, memories, materials }) {
  const allowedMemories = buildAllowedMemoryContext({
    actor,
    memories,
    action: "read",
  });
  const memoryLines = allowedMemories.length
    ? allowedMemories.slice(-8).map((memory) => `- ${memory.content}`)
    : ["- пока нет сохраненных фактов"];
  const materialLines = materials.length
    ? materials.slice(-8).map((material) => `- ${material.title}`)
    : ["- пока нет материалов"];

  return [
    "Что агенты уже используют при ответах:",
    "",
    "Память:",
    ...memoryLines,
    "",
    "Материалы/RAG:",
    ...materialLines,
  ].join("\n");
}

function isDiagnosticsRequest(text) {
  const normalized = normalizeText(text);
  return (
    normalized === "/diag" ||
    normalized === "/diagnostics" ||
    normalized === "/repair" ||
    normalized === "/supervisor" ||
    normalized === "проверка связи" ||
    normalized === "статус связи" ||
    normalized === "связь" ||
    normalized === "ping" ||
    normalized === "пинг" ||
    normalized.includes("диагностик") ||
    normalized.includes("почему долго") ||
    normalized.includes("бот тупит") ||
    normalized.includes("бот долго")
  );
}

function isSupervisorRepairRequest(text) {
  const normalized = normalizeText(text);
  return (
    normalized === "/repair" ||
    normalized === "/supervisor" ||
    normalized === "ремонт" ||
    normalized === "саморемонт" ||
    normalized === "почини бота" ||
    normalized === "почини оркестр" ||
    normalized.includes("запусти supervisor") ||
    normalized.includes("запусти супервизор") ||
    normalized.includes("самодиагностика и ремонт")
  );
}

function canRunSupervisorRepair(actor) {
  return actor?.role === "owner";
}

function canReadWebChatAccess(actor) {
  return actor?.role === "owner";
}

function isWebChatAccessRequest(text) {
  const normalized = String(text ?? "").trim().toLowerCase();
  if (!normalized) return false;

  if (/^\/(?:web|webchat|webcode|web-code|chat|access)(?:@\w+)?$/.test(normalized)) {
    return true;
  }

  return (
    /(?:код\s+доступа|доступн(?:ый|ой)\s+код|парол[ья]?)\s+(?:для\s+)?(?:в[еэ]б|web)/iu.test(normalized) ||
    /(?:в[еэ]б|web)[-\s]?(?:интерфейс|чат|chat).*(?:код|доступ|парол)/iu.test(normalized) ||
    /(?:выдай|дай|покажи|пришли|напомни).*(?:код|доступ|парол).*(?:в[еэ]б|web)/iu.test(normalized) ||
    /(?:выдай|дай|покажи|пришли|напомни).*(?:код|доступ|парол).*(?:к|на|для|от)\s+(?:резервн(?:ый|ому)\s+)?(?:в[еэ]б[-\s]?)?(?:чат|chat|интерфейс)/iu.test(normalized) ||
    /(?:код|доступ|парол[ья]?)\s+(?:к|на|для|от)\s+(?:резервн(?:ый|ому)\s+)?(?:в[еэ]б[-\s]?)?(?:чат|chat|интерфейс)/iu.test(normalized)
  );
}

function normalizeWebChatUrl(url) {
  const value = String(url ?? "").trim();
  return value || "/chat";
}

function buildWebChatAccessAnswer({ accessCode, webChatUrl }) {
  const resolvedUrl = normalizeWebChatUrl(webChatUrl);
  if (!accessCode) {
    return [
      "Веб-чат уже есть, но код доступа не настроен.",
      "Нужно задать переменную WEB_CHAT_ACCESS_CODE в Timeweb App Platform и перезапустить приложение.",
      `Ссылка на веб-чат: ${resolvedUrl}`,
    ].join("\n");
  }

  return [
    "Доступ к резервному веб-чату:",
    `Ссылка: ${resolvedUrl}`,
    `Код: ${accessCode}`,
    "",
    "Telegram остается основным каналом. Веб-чат нужен как запасной вход в тот же оркестр и ту же память.",
  ].join("\n");
}

function isCapabilitiesRequest(text) {
  const normalized = normalizeText(text);
  return (
    normalized === "/tools" ||
    normalized === "/capabilities" ||
    normalized === "инструменты" ||
    normalized === "скилы" ||
    normalized === "skills" ||
    normalized.includes("какие инструменты")
  );
}

function safeTelegramAnswerText(text) {
  const answerText = String(text ?? defaultAnswer).trim() || defaultAnswer;
  if (answerText.length <= telegramSafeAnswerLimit) {
    return answerText;
  }

  return `${answerText.slice(0, telegramSafeAnswerLimit - 90).trim()}\n\nОтвет был слишком длинным, поэтому я сократил его. Напишите: продолжи.`;
}

function durationLabel(durationMs) {
  if (durationMs == null) return "нет данных";
  if (durationMs < 1000) return `${durationMs} мс`;
  return `${(durationMs / 1000).toFixed(1)} сек`;
}

function recentAssistantDiagnostics(messages) {
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) => ({
      action: message.metadata?.action ?? message.metadata?.source ?? "unknown",
      durationMs:
        typeof message.metadata?.durationMs === "number"
          ? message.metadata.durationMs
          : null,
      modelProfile: message.metadata?.modelProfile ?? null,
      createdAt: message.createdAt,
    }));
}

function pollingStateAgeLabel(date, now = new Date()) {
  if (!date) return "нет данных";
  const elapsedMs = Math.max(0, new Date(now).getTime() - new Date(date).getTime());
  if (elapsedMs < 60_000) return `${Math.round(elapsedMs / 1000)} сек назад`;
  if (elapsedMs < 60 * 60_000) return `${Math.round(elapsedMs / 60_000)} мин назад`;
  return `${Math.round(elapsedMs / (60 * 60_000))} ч назад`;
}

function buildPollingStatesDiagnostics(pollingStates = [], now = new Date()) {
  if (!pollingStates.length) {
    return "- Telegram polling: нет сохраненного состояния.";
  }

  return [
    "- Telegram polling:",
    ...pollingStates.map((state) => {
      const parts = [
        `${state.botKey}`,
        `offset ${state.offset ?? "нет"}`,
        `heartbeat ${pollingStateAgeLabel(state.lastHeartbeatAt, now)}`,
      ];
      if (state.lastError) {
        parts.push(`ошибка: ${state.lastError}`);
      }
      return `  - ${parts.join(", ")}`;
    }),
  ].join("\n");
}

function shortDiagnosticJobId(id) {
  return String(id ?? "unknown").slice(0, 8);
}

function truncateDiagnosticText(text, maxLength = 120) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}

function buildFailedJobsDiagnostics(jobs = []) {
  const failedJobs = jobs.filter((job) => job.status === "failed").slice(0, 5);
  if (failedJobs.length === 0) {
    return null;
  }

  return [
    "- Failed jobs:",
    ...failedJobs.map((job) => {
      const payload = job.payload ?? {};
      const update = payload.update ?? {};
      const message = update.message ?? {};
      const result = job.result ?? {};
      const sendWasAttempted =
        result.sendWasAttempted === true ||
        result.stage === "send" ||
        result.stage === "sent" ||
        job.status === "completed";
      const parts = [
        `id ${shortDiagnosticJobId(job.id)}`,
        `type ${job.type}`,
        `bot ${payload.botKey ?? result.botKey ?? "unknown"}`,
        `update ${payload.updateId ?? update.update_id ?? result.updateId ?? "unknown"}`,
        `message ${message.message_id ?? "unknown"}`,
        `chat ${payload.chatId ?? message.chat?.id ?? result.chatId ?? "unknown"}`,
        `attempts ${job.attempts ?? "unknown"}`,
        `stage ${result.stage ?? "unknown"}`,
        `sendWasAttempted ${sendWasAttempted ? "yes" : "no"}`,
      ];
      const error = truncateDiagnosticText(job.error ?? result.error);
      if (error) {
        parts.push(`error ${error}`);
      }
      return `  - ${parts.join(", ")}`;
    }),
  ].join("\n");
}

function buildDiagnosticsAnswer({
  messages,
  memories,
  materialRepositoryAvailable,
  jobs = [],
  supervisorReport = null,
  pollingStates = [],
  now = new Date(),
}) {
  const assistantDiagnostics = recentAssistantDiagnostics(messages);
  const durations = assistantDiagnostics
    .map((diagnostic) => diagnostic.durationMs)
    .filter((durationMs) => durationMs != null);
  const last = assistantDiagnostics.at(-1);
  const slowCount = durations.filter((durationMs) => durationMs >= slowResponseThresholdMs).length;

  return [
    "Самодиагностика бота:",
    "- Telegram-поток работает: команда дошла до сервера.",
    `- Память: доступна, записей в контексте сейчас ${memories.length}.`,
    `- Библиотека материалов: ${materialRepositoryAvailable ? "доступна" : "пока не настроена"}.`,
    buildPollingStatesDiagnostics(pollingStates, now),
    `- Последний ответ: ${durationLabel(last?.durationMs)}; режим: ${last?.action ?? "нет данных"}.`,
    `- Медленных ответов в последних сообщениях: ${slowCount} (порог ${durationLabel(slowResponseThresholdMs)}).`,
    "Если обычные вопросы отвечают долго, узкое место почти всегда внешний AI-вызов. Быстрые команды, память и библиотека отвечают локально.",
    buildFailedJobsDiagnostics(jobs),
    supervisorReport ? "" : null,
    supervisorReport ? formatSupervisorReport(supervisorReport) : null,
  ]
    .filter((line) => line != null)
    .join("\n");
}

function buildSupervisorRepairAnswer(result) {
  return [
    "Supervisor-ремонт выполнен.",
    `- Статус после проверки: ${result.status}.`,
    `- Авто-лечением переотложено задач: ${result.autoHealedJobs}.`,
    "",
    formatSupervisorReport(result.report),
  ].join("\n");
}

async function loadDiagnosticJobs({
  repositories,
  now = new Date(),
  jobLimit = 200,
  staleJobLimit = 100,
} = {}) {
  const [recentJobs, staleJobs] = await Promise.all([
    repositories.jobs?.listRecent
      ? repositories.jobs.listRecent({ limit: jobLimit })
      : [],
    repositories.jobs?.listStaleRunning
      ? repositories.jobs.listStaleRunning({ now, limit: staleJobLimit })
      : [],
  ]);
  const jobsById = new Map();
  for (const job of [...recentJobs, ...staleJobs]) {
    jobsById.set(job.id, job);
  }

  return Array.from(jobsById.values());
}

function buildMaterialListAnswer(materials) {
  if (materials.length === 0) {
    return [
      "В библиотеке пока нет материалов.",
      "Чтобы добавить материал, напишите:",
      "Сохрани материал: Past Simple warm-up",
      "текст упражнения или плана урока",
    ].join("\n");
  }

  return [
    "Материалы в библиотеке:",
    ...materials.slice(-10).map((material) => `- ${material.title}`),
  ].join("\n");
}

async function writeAuditLog(repositories, auditLog) {
  if (!repositories.auditLogs?.create) return;

  try {
    await repositories.auditLogs.create(auditLog);
  } catch (error) {
    console.error("audit log write failed", error);
  }
}

function recentMessagesForPrompt(messages, telegramUpdateId, limit = 6) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .filter((message) => {
      if (message.role === "user") {
        return !sameTelegramUpdate(message, telegramUpdateId, "telegramUpdateId");
      }

      return !sameTelegramUpdate(message, telegramUpdateId, "replyToTelegramUpdateId");
    })
    .slice(-limit)
    .map((message) => ({
      role: message.role,
      content: message.content,
    }));
}

function createRequestContext({
  request,
  conversationId,
  workspaceId,
  messages,
  memories,
  materials = [],
}) {
  return {
    conversationId,
    workspaceId,
    actor: request.actor,
    source: request.source ?? "telegram",
    chatId: request.chatId,
    botKey: request.telegramBotKey,
    memories,
    materials,
    recentMessages: recentMessagesForPrompt(messages, request.telegramUpdateId),
  };
}

function buildCapabilityRunArgs({ request, requestContext, base = {} }) {
  return {
    text: request.text,
    query: request.text,
    actor: request.actor,
    workspaceId: requestContext.workspaceId,
    conversationId: requestContext.conversationId,
    chatId: request.chatId,
    botKey: request.telegramBotKey,
    recentMessages: requestContext.recentMessages,
    memories: requestContext.memories,
    materials: requestContext.materials,
    ...base,
  };
}

async function runWebCurrentDataCapability({
  capabilityRegistry,
  request,
  requestContext,
  memories,
  workspaceId,
}) {
  return capabilityRegistry.run(
    "web_current_data",
    buildCapabilityRunArgs({
      request,
      requestContext,
      base: buildWebCurrentDataArgs({
        request,
        memories,
        workspaceId,
      }),
    }),
  );
}

function shouldRouteUrlThroughCurrentData(text) {
  return isNewsCurrentDataRequest(text) || isCurrentDataRequest(text);
}

function webFetchResultNeedsFallback(result) {
  return (
    result?.metadata?.emptyReadableText === true ||
    /Текстовое содержимое не найдено/i.test(String(result?.text ?? ""))
  );
}

function parseWeatherMetricFocusFromText(text) {
  const normalized = String(text ?? "").toLowerCase();
  if (/(?:ветер|ветр|wind)/i.test(normalized)) return "wind";
  return null;
}

function looksLikeShortContextualFollowUp(text) {
  const normalized = String(text ?? "")
    .replace(/[.!]+$/g, "")
    .trim();
  if (!normalized || normalized.length < 3 || normalized.length > 90) return false;
  if (normalized.startsWith("/") || extractUrls(normalized).length > 0) return false;
  if (/[?]/.test(normalized)) return false;
  if (isWeatherRequest(normalized) || isWindyWeatherRequest(normalized)) return false;
  if (detectRequiredCapability(normalized)) return false;
  if (!/[A-Za-zА-Яа-яЁё]/.test(normalized)) return false;

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 8) return false;

  return !/^(?:да|нет|ок|окей|спасибо|привет|здравствуй|проверка|статус|тест)\b/i.test(
    normalized,
  );
}

function buildWeatherFollowUpArgs({ text, messages }) {
  const mapLocationRequest = parseMapLocationRequest(text);
  if (!looksLikeShortContextualFollowUp(text) && !mapLocationRequest) return null;

  const recentContext = [...messages]
    .reverse()
    .filter((message) =>
      (message.role === "user" || message.role === "assistant") &&
      String(message.content ?? "").trim(),
    )
    .slice(0, 8);
  const recentUserMessages = recentContext.filter((message) => message.role === "user");
  const previousWeatherMessage = recentUserMessages.find((message) =>
    isWeatherRequest(message.content) || isWindyWeatherRequest(message.content),
  );
  if (!previousWeatherMessage) return null;

  const lastUserMessage = recentUserMessages[0] ?? null;
  const assistantAskedForWeatherPlace = recentContext.some((message) =>
    message.role === "assistant" &&
    /(?:уточните населенный пункт|уточните населённый пункт|не нашел город|не нашёл город|пришлите.*координат|погода|прогноз|ветер)/i.test(
      String(message.content ?? ""),
    ),
  );
  if (!mapLocationRequest && previousWeatherMessage !== lastUserMessage && !assistantAskedForWeatherPlace) {
    return null;
  }

  const previousWeatherArgs = parseWeatherRequest(previousWeatherMessage.content);
  const followUpLocationArgs = mapLocationRequest
    ? {}
    : parseWeatherRequest(`в ${String(text ?? "").trim()} погода`);
  const metricFocus =
    previousWeatherArgs.metricFocus ?? parseWeatherMetricFocusFromText(previousWeatherMessage.content);

  return {
    location: followUpLocationArgs.location ?? String(text ?? "").trim(),
    ...(followUpLocationArgs.displayLocation
      ? { displayLocation: followUpLocationArgs.displayLocation }
      : {}),
    target: previousWeatherArgs.target,
    ...(previousWeatherArgs.partOfDay ? { partOfDay: previousWeatherArgs.partOfDay } : {}),
    ...(metricFocus ? { metricFocus } : {}),
    inheritedFrom: "weather_follow_up",
  };
}

function normalizeAssistantTextForQuality(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function detectAssistantQualityIssues({
  request,
  messages = [],
  answerText,
  recentMessages = [],
  memories = [],
  materials = [],
} = {}) {
  const issues = [];
  const normalizedAnswer = normalizeAssistantTextForQuality(answerText);
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && String(message.content ?? "").trim());

  if (
    normalizedAnswer &&
    normalizeAssistantTextForQuality(lastAssistant?.content) === normalizedAnswer
  ) {
    issues.push({
      issue: "duplicate_reply",
      count: 2,
    });
  }

  if (
    looksLikeShortContextualFollowUp(request.text) &&
    recentMessages.length === 0 &&
    memories.length === 0 &&
    materials.length === 0
  ) {
    issues.push({
      issue: "context_underfilled",
      recentMessagesFound: recentMessages.length,
      memoriesFound: memories.length,
      materialsFound: materials.length,
    });
  }

  return issues;
}

export function createRepositoryBackedOrchestrator({
  repositories,
  aiProvider,
  capabilityRegistry = createCapabilityRegistry(),
  workspaceId = "workspace-family",
  webChatAccessCode,
  webChatUrl = "/chat",
  now = () => new Date(),
} = {}) {
  if (!repositories) {
    throw new Error("repositories are required");
  }

  return async function repositoryBackedOrchestrator(request) {
    const requestStartedMs = Date.now();
    const conversationId = conversationIdForRequest(request);
    const requestWorkspaceId = workspaceIdForRequest(request, workspaceId);
    const requestSource = request.source ?? "telegram";
    const createdAt = now();
    const learningCommand = parseLearningCommand(request.text);
    const unsafeLearningCommand = isUnsafeLearningCommand(learningCommand);
    const { userMessage, assistantMessage, messages } =
      await findExistingTelegramExchange(
        repositories,
        conversationId,
        request.telegramUpdateId,
        {
          actorUserId: request.actor.id,
          workspaceId: requestWorkspaceId,
        },
      );

    if (assistantMessage) {
      return {
        accepted: true,
        answer: { text: assistantMessage.content },
        conversationId,
        idempotent: true,
      };
    }

    if (isWebChatAccessRequest(request.text)) {
      let answerText;
      let source = "web_chat_access";

      if (!canReadWebChatAccess(request.actor)) {
        answerText =
          "Код доступа к веб-чату может получить только владелец семейного оркестра.";
        source = "web_chat_access_rejected";
      } else {
        answerText = buildWebChatAccessAnswer({
          accessCode: webChatAccessCode,
          webChatUrl,
        });
      }

      await writeAuditLog(repositories, {
        actorId: request.actor.id,
        action: source,
        resource: conversationId,
        metadata: {
          source: requestSource,
          configured: Boolean(webChatAccessCode),
          durationMs: Date.now() - requestStartedMs,
          ...(request.telegramUpdateId != null
            ? { telegramUpdateId: request.telegramUpdateId }
            : {}),
        },
        createdAt: now(),
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source,
        },
        conversationId,
        secretEphemeral: source === "web_chat_access" && Boolean(webChatAccessCode),
      };
    }

    let activeRequestContext = null;
    const appendAssistantMessage = async ({ answerText, action, metadata = {} }) => {
      const stored = await repositories.conversations.appendMessage(conversationId, {
        role: "assistant",
        content: answerText,
        metadata: {
          source: requestSource,
          ...(request.telegramUpdateId != null
            ? { replyToTelegramUpdateId: request.telegramUpdateId }
            : {}),
          action,
          ...metadata,
        },
        userId: request.actor.id,
        workspaceId: requestWorkspaceId,
        createdAt: now(),
      });
      const qualityIssues = detectAssistantQualityIssues({
        request,
        messages,
        answerText,
        recentMessages: activeRequestContext?.recentMessages ?? [],
        memories: activeRequestContext?.memories ?? [],
        materials: activeRequestContext?.materials ?? [],
      });
      for (const issue of qualityIssues) {
        await writeAuditLog(repositories, {
          actorId: request.actor.id,
          action: "assistant_quality_issue",
          resource: conversationId,
          metadata: {
            ...issue,
            action,
            source: requestSource,
            durationMs: metadata.durationMs,
            ...(request.telegramUpdateId != null
              ? { telegramUpdateId: request.telegramUpdateId }
              : {}),
          },
          createdAt: now(),
        });
      }
      return stored;
    };

    let storedUserMessage = userMessage;
    if (!userMessage) {
      storedUserMessage = await repositories.conversations.appendMessage(conversationId, {
        role: "user",
        content: unsafeLearningCommand ? "[unsafe learning command redacted]" : request.text ?? "",
        metadata: {
          source: requestSource,
          intent: request.intent,
          ...(request.telegramUpdateId != null
            ? { telegramUpdateId: request.telegramUpdateId }
            : {}),
          ...(unsafeLearningCommand ? { redacted: "unsafe_learning_command" } : {}),
        },
        userId: request.actor.id,
        workspaceId: requestWorkspaceId,
        createdAt,
      });
    }

    if (learningCommand?.type === "help") {
      const answerText = buildLearningHelpAnswer(request.actor);
      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: "learning_help",
        metadata: { durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source: "learning_help",
        },
        conversationId,
      };
    }

    if (learningCommand?.type === "memory") {
      const learnedContent = learningCommand.content
        .replace(/[.!?]+$/g, "")
        .trim();

      if (isUnsafeLongTermContent(learnedContent)) {
        const answerText =
          "Я не буду сохранять пароли, токены, ключи, данные карт или документы в память. Лучше не отправлять такие данные в чат.";
        await appendAssistantMessage({
          answerText,
          action: "learning_memory_rejected",
          metadata: { durationMs: Date.now() - requestStartedMs },
        });

        return {
          accepted: true,
          answer: {
            text: answerText,
            source: "learning_memory_rejected",
          },
          conversationId,
        };
      }

      const memory = {
        workspaceId: requestWorkspaceId,
        ownerUserId: request.actor.id,
        scope: memoryScopeForActor(request.actor),
        sensitivity: "normal",
        subjectType: learningSubjectType(request.actor, learningCommand.memoryKind),
        content: learnedContent,
        sourceMessageIds: storedUserMessage?.id ? [storedUserMessage.id] : [],
        confidence: 1,
      };

      if (repositories.memories?.create && canStoreMemory(request.actor, memory)) {
        const existingMemories = repositories.memories?.listForActor
          ? await repositories.memories.listForActor({
              actorUserId: request.actor.id,
              workspaceId: requestWorkspaceId,
              includePrivate: true,
              limit: 100,
            })
          : [];
        if (
          existingMemories.some((existing) =>
            recordHasSourceMessageId(existing, storedUserMessage?.id),
          ) ||
          memoryAlreadyExists(existingMemories, learnedContent)
        ) {
          const answerText = `Уже сохранено: ${learnedContent}`;
          await appendAssistantMessage({
            answerText,
            action: "learning_memory_duplicate",
            metadata: {
              subjectType: memory.subjectType,
              scope: memory.scope,
              durationMs: Date.now() - requestStartedMs,
            },
          });

          return {
            accepted: true,
            answer: {
              text: answerText,
              source: "learning_memory_duplicate",
            },
            conversationId,
          };
        }

        await repositories.memories.create(memory);
        const answerText = [
          `Обучение сохранено: ${learnedContent}`,
          "Буду учитывать это в следующих ответах этого бота.",
        ].join("\n");
        await appendAssistantMessage({
          answerText,
          action: "learning_memory_write",
          metadata: {
            subjectType: memory.subjectType,
            scope: memory.scope,
            durationMs: Date.now() - requestStartedMs,
          },
        });

        return {
          accepted: true,
          answer: {
            text: answerText,
            source: "learning_memory_write",
          },
          conversationId,
        };
      }

      const source = repositories.memories?.create
        ? "learning_memory_rejected"
        : "learning_memory_unavailable";
      const answerText = repositories.memories?.create
        ? "Сохранение памяти недоступно для этого пользователя."
        : "Память пока не подключена к базе. Обучение не сохранено.";
      await appendAssistantMessage({
        answerText,
        action: source,
        metadata: { durationMs: Date.now() - requestStartedMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source,
        },
        conversationId,
      };
    }

    if (learningCommand?.type === "material") {
      let answerText;
      let source = "learning_material_write";
      let metadata = {};

      if (!canStoreMaterial(request.actor)) {
        answerText = "Сохранять материалы в обучение может только подключенный семейный пользователь.";
        source = "learning_material_rejected";
      } else if (!repositories.materials?.create) {
        answerText = "Библиотека материалов пока не подключена к базе.";
        source = "learning_material_unavailable";
      } else if (!learningCommand.title || !learningCommand.content) {
        answerText = [
          "Не вижу название или текст материала.",
          "Формат:",
          "/learn material Past Simple warm-up",
          "текст упражнения или плана урока",
          "",
          "Файл .txt/.md/.csv можно отправить с подписью: /learn material Название",
        ].join("\n");
        source = "learning_material_invalid";
      } else if (isUnsafeLongTermContent(`${learningCommand.title}\n${learningCommand.content}`)) {
        answerText = "Я не буду сохранять материалы с паролями, токенами, ключами или данными карт.";
        source = "learning_material_rejected";
      } else {
        const existingMaterials = repositories.materials?.listForActor
          ? await repositories.materials.listForActor({
              actorUserId: request.actor.id,
              workspaceId: requestWorkspaceId,
              limit: 100,
            })
          : [];
        if (
          materialAlreadyExists(existingMaterials, {
            title: learningCommand.title,
            sourceMessageId: storedUserMessage?.id,
          })
        ) {
          answerText = `Материал уже есть в библиотеке: ${learningCommand.title}`;
          source = "learning_material_duplicate";
        } else {
        const storedMaterial = await repositories.materials.create({
          workspaceId: requestWorkspaceId,
          ownerUserId: request.actor.id,
          scope: materialScopeForActor(request.actor),
          sensitivity: "normal",
          title: learningCommand.title.slice(0, 160),
          content: learningCommand.content,
          mimeType: "text/plain",
          sourceMessageIds: storedUserMessage?.id ? [storedUserMessage.id] : [],
        });
        metadata = {
          materialId: storedMaterial.id,
          chunkCount: storedMaterial.chunks?.length ?? 0,
          scope: storedMaterial.scope,
        };
        answerText = [
          `Материал добавлен в обучение: ${storedMaterial.title}`,
          `Фрагментов в RAG-библиотеке: ${metadata.chunkCount}.`,
          "Теперь агент будет использовать его при ответах и подготовке материалов.",
        ].join("\n");
        }
      }

      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: source,
        metadata: { ...metadata, durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source,
        },
        conversationId,
      };
    }

    const explicitMemory = extractExplicitMemory(request.text);
    if (explicitMemory) {
      if (isUnsafeLongTermContent(explicitMemory)) {
        const answerText =
          "Я не буду сохранять пароли, токены, ключи, данные карт или документы в память. Лучше не отправлять такие данные в чат.";
        await appendAssistantMessage({
          answerText,
          action: "memory_rejected",
          metadata: { durationMs: Date.now() - requestStartedMs },
        });

        return {
          accepted: true,
          answer: {
            text: answerText,
            source: "memory_rejected",
          },
          conversationId,
        };
      }

      const memory = {
        workspaceId: requestWorkspaceId,
        ownerUserId: request.actor.id,
        scope: memoryScopeForActor(request.actor),
        sensitivity: "normal",
        subjectType: "user_stated_fact",
        content: explicitMemory,
        sourceMessageIds: storedUserMessage?.id ? [storedUserMessage.id] : [],
        confidence: 1,
      };

      if (repositories.memories?.create && canStoreMemory(request.actor, memory)) {
        const existingMemories = repositories.memories?.listForActor
          ? await repositories.memories.listForActor({
              actorUserId: request.actor.id,
              workspaceId: requestWorkspaceId,
              includePrivate: true,
              limit: 100,
            })
          : [];
        if (
          existingMemories.some((existing) =>
            recordHasSourceMessageId(existing, storedUserMessage?.id),
          ) ||
          memoryAlreadyExists(existingMemories, explicitMemory)
        ) {
          const answerText = `Уже запомнено: ${explicitMemory}`;
          await appendAssistantMessage({
            answerText,
            action: "memory_duplicate",
            metadata: { durationMs: Date.now() - requestStartedMs },
          });

          return {
            accepted: true,
            answer: {
              text: answerText,
              source: "memory_duplicate",
            },
            conversationId,
          };
        }

        await repositories.memories.create(memory);
        const answerText = `Запомнил: ${explicitMemory}`;
        await appendAssistantMessage({
          answerText,
          action: "memory_write",
          metadata: { durationMs: Date.now() - requestStartedMs },
        });

        return {
          accepted: true,
          answer: {
            text: answerText,
            source: "memory_write",
          },
          conversationId,
        };
      }
    }

    let memoryCandidates = repositories.memories?.listForActor
      ? await repositories.memories.listForActor({
          actorUserId: request.actor.id,
          workspaceId: requestWorkspaceId,
          limit: memoryRecentCandidateLimit,
        })
      : [];
    let automaticMemories = await storeAutomaticMemories({
      repositories,
      request,
      storedUserMessage,
      workspaceId: requestWorkspaceId,
      memories: memoryCandidates,
    });
    if (automaticMemories.length > 0) {
      memoryCandidates = mergeMemoryLists(
        [memoryCandidates, automaticMemories],
        memoryRecentCandidateLimit,
      );
      const summary = await upsertMemoryProfileSummary({
        repositories,
        actor: request.actor,
        workspaceId: requestWorkspaceId,
        memories: memoryCandidates,
        sourceMessageIds: storedUserMessage?.id ? [storedUserMessage.id] : [],
      });
      if (summary) {
        memoryCandidates = mergeMemoryLists(
          [[summary], memoryCandidates],
          memoryRecentCandidateLimit,
        );
      }
    }
    const memories = await loadRelevantMemories({
      repositories,
      actor: request.actor,
      workspaceId: requestWorkspaceId,
      text: request.text,
      fallbackMemories: memoryCandidates,
    });
    const requestContext = createRequestContext({
      request,
      conversationId,
      workspaceId: requestWorkspaceId,
      messages,
      memories,
    });
    activeRequestContext = requestContext;

    if (isMemoryProfileRequest(request.text)) {
      const profileMemories = await loadMemoryProfileMemories({
        repositories,
        actor: request.actor,
        workspaceId: requestWorkspaceId,
        fallbackMemories: memories,
      });
      const answerText = buildMemoryProfileAnswer({
        actor: request.actor,
        memories: profileMemories,
      });
      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: "memory_profile",
        metadata: { durationMs, memoryCount: profileMemories.length },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source: "memory_profile",
        },
        conversationId,
      };
    }

    if (isMemoryConsolidationRequest(request.text)) {
      const profileMemories = await loadMemoryProfileMemories({
        repositories,
        actor: request.actor,
        workspaceId: requestWorkspaceId,
        fallbackMemories: memories,
      });
      const consolidatedText = buildConsolidatedMemoryText({
        actor: request.actor,
        memories: profileMemories,
      });
      let answerText;
      let source = "memory_consolidation";
      if (!consolidatedText) {
        answerText = "Пока нечего консолидировать: в памяти нет устойчивых фактов.";
        source = "memory_consolidation_empty";
      } else if (!repositories.memories?.create && !repositories.memories?.upsertSummary) {
        answerText = "Профиль собран, но хранилище памяти сейчас недоступно.";
        source = "memory_consolidation_unavailable";
      } else {
        const summaryMemory = {
          workspaceId: requestWorkspaceId,
          ownerUserId: request.actor.id,
          scope: memoryScopeForActor(request.actor),
          sensitivity: "normal",
          subjectType: "profile_summary",
          subjectId: request.actor.id,
          content: consolidatedText,
          summary: consolidatedText,
          confidence: 0.82,
          sourceMessageIds: storedUserMessage?.id ? [storedUserMessage.id] : [],
        };
        if (repositories.memories.upsertSummary) {
          await repositories.memories.upsertSummary(summaryMemory);
        } else {
          await repositories.memories.create(summaryMemory);
        }
        answerText = [
          "Профиль памяти обновлен.",
          "",
          consolidatedText,
        ].join("\n");
      }

      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: source,
        metadata: { durationMs, memoryCount: profileMemories.length },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source,
        },
        conversationId,
      };
    }

    if (isCapabilitiesRequest(request.text)) {
      const answerText = buildCapabilitiesAnswer(capabilityRegistry);
      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: "capability_list",
        metadata: { durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source: "capability_list",
        },
        conversationId,
      };
    }

    if (isDiagnosticsRequest(request.text)) {
      if (isSupervisorRepairRequest(request.text)) {
        let answerText;
        let source = "supervisor_repair";
        let metadata = {};

        if (!canRunSupervisorRepair(request.actor)) {
          answerText = "Запускать supervisor-ремонт может только владелец семейного оркестра.";
          source = "supervisor_repair_rejected";
        } else {
          const result = await runSupervisorTick({
            repositories,
            now: now(),
            autoHeal: true,
            healFailedTelegramUpdates: true,
            notifier: undefined,
          });
          answerText = buildSupervisorRepairAnswer(result);
          metadata = {
            status: result.status,
            autoHealedJobs: result.autoHealedJobs,
            findingCodes: result.report.findings.map((finding) => finding.code),
          };
        }

        const durationMs = Date.now() - requestStartedMs;
        await appendAssistantMessage({
          answerText,
          action: source,
          metadata: { ...metadata, durationMs },
        });

        return {
          accepted: true,
          answer: {
            text: answerText,
            source,
          },
          conversationId,
        };
      }

      const diagnosticMessages = repositories.conversations.listMessages
        ? await repositories.conversations.listMessages(conversationId, {
            limit: diagnosticsLookupLimit,
          })
        : messages;
      const diagnosticNow = now();
      const diagnosticJobs = repositories.jobs
        ? await loadDiagnosticJobs({
            repositories,
            now: diagnosticNow,
          })
        : [];
      const diagnosticAuditLogs = repositories.auditLogs?.listRecent
        ? await repositories.auditLogs.listRecent({ limit: 100 })
        : [];
      const diagnosticPollingStates = repositories.telegramPollingStates?.list
        ? await repositories.telegramPollingStates.list()
        : [];
      const supervisorReport = analyzeSupervisorState({
        jobs: diagnosticJobs,
        auditLogs: diagnosticAuditLogs,
        now: diagnosticNow,
      });
      const answerText = buildDiagnosticsAnswer({
        messages: diagnosticMessages,
        memories,
        materialRepositoryAvailable: Boolean(repositories.materials?.search),
        jobs: diagnosticJobs,
        supervisorReport,
        pollingStates: diagnosticPollingStates,
        now: diagnosticNow,
      });
      const durationMs = Date.now() - requestStartedMs;
      await writeAuditLog(repositories, {
        actorId: request.actor.id,
        action: "bot_diagnostics_requested",
        resource: conversationId,
        metadata: {
          durationMs,
          source: requestSource,
          ...(request.telegramUpdateId != null
            ? { telegramUpdateId: request.telegramUpdateId }
            : {}),
        },
        createdAt: now(),
      });
      await appendAssistantMessage({
        answerText,
        action: "diagnostics",
        metadata: { durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source: "diagnostics",
        },
        conversationId,
      };
    }

    if (learningCommand?.type === "list") {
      const materials = repositories.materials?.listForActor
        ? await repositories.materials.listForActor({
            actorUserId: request.actor.id,
            workspaceId: requestWorkspaceId,
            limit: 8,
          })
        : [];
      const answerText = buildLearningListAnswer({
        actor: request.actor,
        memories,
        materials,
      });
      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: "learning_list",
        metadata: { durationMs, materialCount: materials.length, memoryCount: memories.length },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source: "learning_list",
        },
        conversationId,
      };
    }

    const requestIsMaterialCommand =
      parseMaterialCommand(request.text)?.matched ||
      isMaterialListRequest(request.text) ||
      learningCommand?.type === "material" ||
      learningCommand?.type === "list";
    const weatherFollowUpArgs = !requestIsMaterialCommand
      ? buildWeatherFollowUpArgs({ text: request.text, messages })
      : null;

    if (!requestIsMaterialCommand && isWindyWeatherRequest(request.text)) {
      let answerText;
      let source = "windy_weather";
      let metadata = {};

      if (!capabilityRegistry?.has?.("windy_weather")) {
        answerText = buildMissingCapabilityAnswer("windy_weather", request.text);
        source = "capability_missing";
        metadata = { capability: "windy_weather" };
      } else {
        try {
          const urls = extractUrls(request.text);
          const result = await capabilityRegistry.run(
            "windy_weather",
            buildCapabilityRunArgs({
              request,
              requestContext,
              base: {
                url: urls[0],
                ...parseWindyRequest(request.text),
              },
            }),
          );
          answerText = result.text;
          metadata = result.metadata ?? {};
        } catch (error) {
          answerText = [
            "Я распознал ссылку Windy, но не смог получить прогноз по координатам.",
            "Нужный инструмент: windy_weather.",
            "Попробуйте повторить запрос позже или пришлите координаты текстом.",
          ].join("\n");
          source = "windy_weather_error";
          metadata = {
            errorMessage: String(error.message ?? "").slice(0, 240),
          };
        }
      }

      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: source,
        metadata: { ...metadata, durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source,
        },
        conversationId,
      };
    }

    const mapLocationRequest = !requestIsMaterialCommand
      ? parseMapLocationRequest(request.text)
      : null;
    const mapReferenceRequest = !requestIsMaterialCommand
      ? parseMapReferenceRequest(request.text)
      : null;

    if (
      !requestIsMaterialCommand &&
      !isMapReferenceRequest(request.text) &&
      isWebFetchRequest(request.text) &&
      !(
        shouldRouteUrlThroughCurrentData(request.text) &&
        capabilityRegistry?.has?.("web_current_data")
      )
    ) {
      let answerText;
      let source = "web_fetch_url";
      let metadata = {};

      if (!capabilityRegistry?.has?.("web_fetch_url")) {
        answerText = buildMissingCapabilityAnswer("web_fetch_url", request.text);
        source = "capability_missing";
        metadata = { capability: "web_fetch_url" };
      } else {
        try {
          const urls = extractUrls(request.text);
          const result = await capabilityRegistry.run(
            "web_fetch_url",
            buildCapabilityRunArgs({
              request,
              requestContext,
              base: { url: urls[0] },
            }),
          );
          if (
            webFetchResultNeedsFallback(result) &&
            capabilityRegistry?.has?.("web_current_data")
          ) {
            const fallbackResult = await runWebCurrentDataCapability({
              capabilityRegistry,
              request,
              requestContext,
              memories,
              workspaceId: requestWorkspaceId,
            });
            answerText = fallbackResult.text;
            source = fallbackResult.source ?? "web_current_data";
            metadata = {
              ...(fallbackResult.metadata ?? {}),
              fallbackFrom: "web_fetch_url",
              directFetchEmpty: true,
            };
          } else {
            answerText = result.text;
            metadata = result.metadata ?? {};
          }
        } catch (error) {
          if (capabilityRegistry?.has?.("web_current_data")) {
            try {
              const fallbackResult = await runWebCurrentDataCapability({
                capabilityRegistry,
                request,
                requestContext,
                memories,
                workspaceId: requestWorkspaceId,
              });
              answerText = fallbackResult.text;
              source = fallbackResult.source ?? "web_current_data";
              metadata = {
                ...(fallbackResult.metadata ?? {}),
                fallbackFrom: "web_fetch_url",
                primaryErrorMessage: String(error.message ?? "").slice(0, 240),
              };
            } catch (fallbackError) {
              answerText = [
                "Я попытался прочитать ссылку напрямую и через запасной поиск, но источник не ответил.",
                "Нужные инструменты: web_fetch_url и web_current_data.",
                "Повторите запрос позже или пришлите другую публичную ссылку.",
              ].join("\n");
              source = "web_fetch_error";
              metadata = {
                errorMessage: String(error.message ?? "").slice(0, 240),
                fallbackErrorMessage: String(fallbackError.message ?? "").slice(0, 240),
              };
            }
          } else {
            answerText = [
              "Я попытался прочитать ссылку через инструмент, но источник не ответил.",
              "Нужный инструмент: web_fetch_url.",
              "Для запасного поиска нужен web_current_data provider.",
            ].join("\n");
            source = "web_fetch_error";
            metadata = {
              errorMessage: String(error.message ?? "").slice(0, 240),
            };
          }
        }
      }

      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: source,
        metadata: { ...metadata, durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source,
        },
        conversationId,
      };
    }

    if (!requestIsMaterialCommand && (isWeatherRequest(request.text) || weatherFollowUpArgs)) {
      let answerText;
      let source = "weather_forecast";
      let metadata = {};
      const weatherArgs = {
        ...(weatherFollowUpArgs ?? parseWeatherRequest(request.text)),
        ...(mapLocationRequest
          ? {
              latitude: mapLocationRequest.latitude,
              longitude: mapLocationRequest.longitude,
              location: `coordinates ${mapLocationRequest.latitude}, ${mapLocationRequest.longitude}`,
              displayLocation: "точка на карте",
            }
          : {}),
      };

      if (mapReferenceRequest && !mapLocationRequest) {
        answerText = [
          "Распознал ссылку Яндекс.Карт, но в ней нет координат точки.",
          "Чтобы рассчитать погоду или ветер по месту, пришлите полную ссылку с параметром ll=... или напишите адрес/название места текстом.",
        ].join("\n");
        source = "map_coordinates_missing";
        metadata = mapReferenceRequest;
      } else if (
        !capabilityRegistry?.has?.("weather_forecast") &&
        !capabilityRegistry?.has?.("weather_fallback_wttr")
      ) {
        answerText = buildMissingCurrentDataCapabilityAnswer(request.text);
        source = "capability_missing";
      } else {
        try {
          const weather = capabilityRegistry?.has?.("weather_forecast")
            ? await capabilityRegistry.run(
                "weather_forecast",
                buildCapabilityRunArgs({ request, requestContext, base: weatherArgs }),
              )
            : await capabilityRegistry.run(
                "weather_fallback_wttr",
                buildCapabilityRunArgs({ request, requestContext, base: weatherArgs }),
              );
          answerText = weather.text;
          metadata = weather.metadata ?? {};
        } catch (error) {
          if (
            capabilityRegistry?.has?.("weather_forecast") &&
            capabilityRegistry?.has?.("weather_fallback_wttr")
          ) {
            try {
              const fallbackWeather = await capabilityRegistry.run(
                "weather_fallback_wttr",
                buildCapabilityRunArgs({ request, requestContext, base: weatherArgs }),
              );
              const durationMs = Date.now() - requestStartedMs;
              await appendAssistantMessage({
                answerText: fallbackWeather.text,
                action: source,
                metadata: {
                  ...(fallbackWeather.metadata ?? {}),
                  fallbackSource: "weather_fallback_wttr",
                  primaryErrorMessage: String(error.message ?? "").slice(0, 240),
                  durationMs,
                },
              });

              return {
                accepted: true,
                answer: {
                  text: fallbackWeather.text,
                  source,
                },
                conversationId,
              };
            } catch (fallbackError) {
              metadata = {
                errorMessage: String(error.message ?? "").slice(0, 240),
                fallbackErrorMessage: String(fallbackError.message ?? "").slice(0, 240),
              };
            }
          }

          answerText = [
            "Я попытался получить прогноз погоды через инструмент, но источник не ответил.",
            "Нужный инструмент: weather_forecast.",
            "Попробуйте повторить запрос чуть позже или напишите: диагностика.",
          ].join("\n");
          source = "weather_error";
          metadata = {
            ...metadata,
            errorMessage: String(error.message ?? "").slice(0, 240),
          };
        }
      }

      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: source,
        metadata: { ...metadata, durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source,
        },
        conversationId,
      };
    }

    if (!requestIsMaterialCommand && isTimeLocationRequest(request.text)) {
      let answerText;
      let source = "time_location_context";
      let metadata = {};

      if (!capabilityRegistry?.has?.("time_location_context")) {
        answerText = buildMissingCapabilityAnswer("time_location_context", request.text);
        source = "capability_missing";
        metadata = { capability: "time_location_context" };
      } else {
        const result = await capabilityRegistry.run(
          "time_location_context",
          buildCapabilityRunArgs({ request, requestContext }),
        );
        answerText = result.text;
        metadata = result.metadata ?? {};
      }

      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: source,
        metadata: { ...metadata, durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source,
        },
        conversationId,
      };
    }

    if (!requestIsMaterialCommand && (isMapReferenceRequest(request.text) || isTravelLocalRequest(request.text))) {
      let answerText;
      let source = "travel_local";
      let metadata = {};

      if (!mapReferenceRequest && !capabilityRegistry?.has?.("travel_local")) {
        answerText = buildMissingCapabilityAnswer("travel_local", request.text);
        source = "capability_missing";
        metadata = { capability: "travel_local" };
      } else {
        try {
          if (mapLocationRequest) {
            answerText = [
              "Распознал точку на карте.",
              `Координаты: ${mapLocationRequest.latitude}, ${mapLocationRequest.longitude}.`,
              "Источник: Yandex Maps URL.",
            ].join("\n");
            metadata = mapLocationRequest;
          } else if (mapReferenceRequest) {
            answerText = [
              "Распознал ссылку Яндекс.Карт, но координаты точки в ней не нашел.",
              "Пришлите полную ссылку из кнопки «Поделиться» или напишите адрес/название места текстом.",
            ].join("\n");
            source = "map_coordinates_missing";
            metadata = mapReferenceRequest;
          } else {
            const result = await capabilityRegistry.run(
              "travel_local",
              buildCapabilityRunArgs({
                request,
                requestContext,
                base: parseLocationLookupRequest(request.text),
              }),
            );
            answerText = result.text;
            metadata = result.metadata ?? {};
          }
        } catch (error) {
          answerText = [
            "Я попытался найти место через карту, но источник не ответил.",
            "Нужный инструмент: travel_local.",
            "Попробуйте повторить запрос позже или уточните адрес.",
          ].join("\n");
          source = "travel_local_error";
          metadata = {
            errorMessage: String(error.message ?? "").slice(0, 240),
          };
        }
      }

      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: source,
        metadata: { ...metadata, durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source,
        },
        conversationId,
      };
    }

    const requiredCapability = !requestIsMaterialCommand
      ? detectRequiredCapability(request.text)
      : null;
    const directlyRunnableCapabilities = new Set([
      "web_current_data",
      "calendar_scheduling",
      "email_triage",
      "tasks_reminders",
      "daily_briefing",
      "shopping_orders",
      "automation",
    ]);
    if (
      requiredCapability &&
      directlyRunnableCapabilities.has(requiredCapability) &&
      capabilityRegistry?.has?.(requiredCapability)
    ) {
      let answerText;
      let source = requiredCapability;
      let metadata = {};

      try {
        const args =
          requiredCapability === "web_current_data"
            ? buildCapabilityRunArgs({
                request,
                requestContext,
                base: buildWebCurrentDataArgs({
                  request,
                  memories,
                  workspaceId: requestWorkspaceId,
                }),
              })
            : buildCapabilityRunArgs({ request, requestContext });
        const result = await capabilityRegistry.run(requiredCapability, args);
        answerText = result.text;
        source = result.source ?? source;
        metadata = result.metadata ?? {};
      } catch (error) {
        answerText = [
          "Я попробовал вызвать нужный инструмент, но источник не ответил.",
          `Нужный инструмент: ${requiredCapability}.`,
          "Повторите запрос позже или подключите более надежный provider для этой возможности.",
        ].join("\n");
        source = `${requiredCapability}_error`;
        metadata = {
          capability: requiredCapability,
          errorMessage: String(error.message ?? "").slice(0, 240),
        };
      }

      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: source,
        metadata: { ...metadata, durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source,
        },
        conversationId,
      };
    }
    const locallyHandledCapabilities = new Set([
      "weather_forecast",
      "web_fetch_url",
      "time_location_context",
      "travel_local",
    ]);
    if (
      requiredCapability &&
      !locallyHandledCapabilities.has(requiredCapability) &&
      !capabilityRegistry?.has?.(requiredCapability)
    ) {
      const answerText = buildMissingCapabilityAnswer(requiredCapability, request.text);
      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: "capability_missing",
        metadata: { capability: requiredCapability, durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source: "capability_missing",
        },
        conversationId,
      };
    }

    const materialCommand = parseMaterialCommand(request.text);
    if (materialCommand?.matched) {
      let answerText;
      let source = "material_write";
      let metadata = {};

      if (!canStoreMaterial(request.actor)) {
        answerText = "Сохранять материалы может владелец или бот преподавателя.";
        source = "material_rejected";
      } else if (!repositories.materials?.create) {
        answerText = "Библиотека материалов пока не подключена к базе.";
        source = "material_unavailable";
      } else if (!materialCommand.title || !materialCommand.content) {
        answerText = [
          "Не вижу название или текст материала.",
          "Формат:",
          "Сохрани материал: Past Simple warm-up",
          "текст упражнения или плана урока",
        ].join("\n");
        source = "material_invalid";
      } else if (isUnsafeLongTermContent(`${materialCommand.title}\n${materialCommand.content}`)) {
        answerText = "Я не буду сохранять материалы с паролями, токенами, ключами или данными карт.";
        source = "material_rejected";
      } else {
        const existingMaterials = repositories.materials?.listForActor
          ? await repositories.materials.listForActor({
              actorUserId: request.actor.id,
              workspaceId: requestWorkspaceId,
              limit: 100,
            })
          : [];
        if (
          materialAlreadyExists(existingMaterials, {
            title: materialCommand.title,
            sourceMessageId: storedUserMessage?.id,
          })
        ) {
          answerText = `Материал уже есть в библиотеке: ${materialCommand.title}`;
          source = "material_duplicate";
        } else {
        const storedMaterial = await repositories.materials.create({
          workspaceId: requestWorkspaceId,
          ownerUserId: request.actor.id,
          scope: materialScopeForActor(request.actor),
          sensitivity: "normal",
          title: materialCommand.title.slice(0, 160),
          content: materialCommand.content,
          mimeType: "text/plain",
          sourceMessageIds: storedUserMessage?.id ? [storedUserMessage.id] : [],
        });
        metadata = {
          materialId: storedMaterial.id,
          chunkCount: storedMaterial.chunks?.length ?? 0,
        };
        answerText = [
          `Материал сохранен: ${storedMaterial.title}`,
          `Фрагментов в библиотеке: ${metadata.chunkCount}.`,
          "Теперь я буду искать по нему при подготовке уроков и ответах по материалам.",
        ].join("\n");
        }
      }

      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: source,
        metadata: { ...metadata, durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source,
        },
        conversationId,
      };
    }

    if (isMaterialListRequest(request.text)) {
      const materials = repositories.materials?.listForActor
        ? await repositories.materials.listForActor({
            actorUserId: request.actor.id,
            workspaceId: requestWorkspaceId,
            limit: 10,
          })
        : [];
      const answerText = buildMaterialListAnswer(materials);
      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: "material_list",
        metadata: { durationMs, materialCount: materials.length },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source: "material_list",
        },
        conversationId,
      };
    }

    if (isMemoryRecallRequest(request.text)) {
      const answerText = buildMemoryRecallAnswer({
        actor: request.actor,
        memories,
      });
      const durationMs = Date.now() - requestStartedMs;
      await appendAssistantMessage({
        answerText,
        action: "memory_recall",
        metadata: { durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source: "memory_recall",
        },
        conversationId,
      };
    }

    const materialChunks = repositories.materials?.search
      ? await repositories.materials.search({
          actorUserId: request.actor.id,
          workspaceId: requestWorkspaceId,
          query: request.text,
          limit: materialContextLimit,
        })
      : [];
    const aiRequestContext = createRequestContext({
      request,
      conversationId,
      workspaceId: requestWorkspaceId,
      messages,
      memories,
      materials: materialChunks,
    });
    activeRequestContext = aiRequestContext;

    let response;
    try {
      response = await handleOrchestratorRequest(
        {
          ...request,
          memories: aiRequestContext.memories,
          materials: aiRequestContext.materials,
          recentMessages: aiRequestContext.recentMessages,
        },
        { aiProvider },
      );
    } catch (error) {
      const durationMs = Date.now() - requestStartedMs;
      const answerText =
        "AI-сервис сейчас не дал ответ. Я записал сбой в самодиагностику. Попробуйте повторить вопрос короче или напишите: диагностика.";
      await writeAuditLog(repositories, {
        actorId: request.actor.id,
        action: "ai_response_failed",
        resource: conversationId,
        metadata: {
          durationMs,
          errorName: error.name,
          errorMessage: String(error.message ?? "").slice(0, 240),
          ...(request.telegramUpdateId != null
            ? { telegramUpdateId: request.telegramUpdateId }
            : {}),
        },
        createdAt: now(),
      });
      await appendAssistantMessage({
        answerText,
        action: "ai_error",
        metadata: { durationMs },
      });

      return {
        accepted: true,
        answer: {
          text: answerText,
          source: "ai_error",
        },
        conversationId,
      };
    }

    const answer = response.answer ?? { text: defaultAnswer };
    const answerText = safeTelegramAnswerText(answer.text ?? defaultAnswer);
    const durationMs = Date.now() - requestStartedMs;
    const action =
      answer.text && String(answer.text).trim()
        ? answer.source ?? "ai_response"
        : "ai_empty";

    if (durationMs >= slowResponseThresholdMs || action === "ai_empty") {
      await writeAuditLog(repositories, {
        actorId: request.actor.id,
        action: durationMs >= slowResponseThresholdMs ? "ai_response_slow" : "ai_response_empty",
        resource: conversationId,
        metadata: {
          durationMs,
          action,
          materialContextCount: materialChunks.length,
          automaticMemoryCount: automaticMemories.length,
          ...(request.telegramUpdateId != null
            ? { telegramUpdateId: request.telegramUpdateId }
            : {}),
        },
        createdAt: now(),
      });
    }

    await appendAssistantMessage({
      answerText,
      action,
      metadata: {
        agentProfile: response.agentProfile,
        modelProfile: response.modelProfile,
        durationMs,
        materialContextCount: materialChunks.length,
        automaticMemoryCount: automaticMemories.length,
      },
    });

    return {
      ...response,
      answer: {
        ...answer,
        text: answerText,
      },
      conversationId,
    };
  };
}
