/**
 * Transforma eventos persistidos da sessão em itens compactos para a UI.
 * Nenhum texto é traduzido aqui: o Client decide os rótulos de estado.
 */

const LIMITS = Object.freeze({
  user: 12_000,
  assistant: 20_000,
  reasoning: 2_000,
  toolInput: 1_500,
  toolSummary: 260,
  toolOutput: 4_000,
  reason: 800,
  title: 120,
});

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {{text: string, truncated: boolean, length: number}}
 */
export function clip(value, max) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= max) {
    return { text, truncated: false, length: text.length };
  }
  return {
    text: text.slice(0, max),
    truncated: true,
    length: text.length,
  };
}

/** @param {unknown} value */
function oneLine(value, max = 160) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return clip(text.replace(/\s+/g, " ").trim(), max).text;
}

/**
 * Extrai texto, raciocínio e contagem de imagens de blocos de conteúdo.
 * @param {unknown} content
 * @returns {{text: string, reasoning: string, images: number}}
 */
function contentParts(content) {
  let text = "";
  let reasoning = "";
  let images = 0;
  if (!Array.isArray(content)) return { text, reasoning, images };

  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const type = block.type;
    if (type === "text" && typeof block.text === "string") {
      text += (text.length > 0 ? "\n" : "") + block.text;
    } else if (type === "reasoning" && typeof block.text === "string") {
      reasoning += (reasoning.length > 0 ? "\n" : "") + block.text;
    } else if (type === "image") {
      images += 1;
    }
  }
  return { text, reasoning, images };
}

/**
 * @param {unknown} value
 * @returns {object|null}
 */
function parseArguments(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : "";
}

/**
 * Resumo de uma chamada de ferramenta, pensado para uma linha.
 * @param {string} name
 * @param {object|null} args
 * @param {string} rawArguments
 * @returns {string}
 */
function summarizeTool(name, args, rawArguments) {
  const a = args ?? {};
  const pick = (...keys) => {
    for (const key of keys) {
      const value = nonEmptyString(a[key]);
      if (value.length > 0) return value;
    }
    return "";
  };

  if (name === "bash" || name === "shell") {
    const description = pick("description");
    const command = pick("command");
    const summary = description || oneLine(command.split("\n")[0] ?? "", 220);
    return clip(summary, LIMITS.toolSummary).text;
  }

  if (name === "read" || name === "write" || name === "edit" || name === "apply_patch") {
    return clip(pick("file_path", "path", "description") || oneLine(rawArguments, 220), LIMITS.toolSummary).text;
  }

  if (name === "grep") {
    const pattern = pick("pattern");
    const path = pick("path");
    return clip(path && pattern ? `${pattern}  ·  ${path}` : pattern || path || oneLine(rawArguments, 220), LIMITS.toolSummary).text;
  }

  if (name === "glob" || name === "find") {
    const pattern = pick("pattern");
    const path = pick("path");
    return clip(path && pattern ? `${pattern}  ·  ${path}` : pattern || path || oneLine(rawArguments, 220), LIMITS.toolSummary).text;
  }

  if (name === "web_fetch") return clip(pick("url") || oneLine(rawArguments, 220), LIMITS.toolSummary).text;
  if (name === "web_search") return clip(pick("query") || oneLine(rawArguments, 220), LIMITS.toolSummary).text;
  if (name === "skill") return clip(pick("name") || oneLine(rawArguments, 220), LIMITS.toolSummary).text;
  if (name === "todo_write") return "atualizar lista de tarefas";
  if (name === "present") return clip(pick("description") || "apresentar entregáveis", LIMITS.toolSummary).text;

  const fallback = pick(
    "description",
    "command",
    "query",
    "path",
    "file_path",
    "url",
    "prompt",
    "name",
    "id",
  );
  if (fallback) return clip(fallback, LIMITS.toolSummary).text;
  return clip(oneLine(rawArguments, 220), LIMITS.toolSummary).text || name;
}

/**
 * Texto de entrada mostrado no cartão de ferramenta.
 * @param {string} name
 * @param {object|null} args
 * @param {string} rawArguments
 * @returns {string}
 */
function toolInput(name, args, rawArguments) {
  const a = args ?? {};
  let value = "";
  if (name === "bash" || name === "shell") {
    value = nonEmptyString(a.command);
  } else if (name === "read" || name === "write" || name === "edit" || name === "apply_patch") {
    value = nonEmptyString(a.file_path) || nonEmptyString(a.path);
  } else if (name === "grep" || name === "glob" || name === "find") {
    value = [nonEmptyString(a.pattern), nonEmptyString(a.path)].filter(Boolean).join("\n");
  } else if (args !== null) {
    try {
      value = JSON.stringify(args, null, 2);
    } catch {
      value = rawArguments;
    }
  }
  if (!value) value = rawArguments;
  const result = clip(value, LIMITS.toolInput);
  return result.text + (result.truncated ? `\n… (${result.length} caracteres)` : "");
}

/**
 * @param {object} event
 * @param {{currentTurn?: number|null}} context
 * @returns {object|null}
 */
export function itemForEvent(event, context = {}) {
  const type = event.type;
  const data = event.data ?? {};
  const seq = eventSeq(event);
  const time = eventTime(event);
  const eventTurn = Number.isInteger(data.turn) ? data.turn : null;
  const turn = eventTurn ?? (Number.isInteger(context.currentTurn) ? context.currentTurn : null);
  const step = Number.isInteger(data.step) ? data.step : null;

  const base = (kind) => ({ kind, seq, time, turn, step });

  switch (type) {
    case "turn/start":
      return { ...base("turn_start"), turn: eventTurn ?? turn };

    case "turn/end": {
      const reason = data.reason ?? null;
      const kind = typeof reason?.kind === "string" ? reason.kind : "unknown";
      const detail = nonEmptyString(reason?.error?.message)
        || nonEmptyString(reason?.message)
        || nonEmptyString(reason?.reason?.kind)
        || "";
      const code = nonEmptyString(reason?.error?.code) || nonEmptyString(reason?.code);
      const clipped = clip(detail, LIMITS.reason);
      return {
        ...base("turn_end"),
        turn: eventTurn ?? turn,
        reasonKind: kind,
        reasonDetail: clipped.text,
        reasonDetailTruncated: clipped.truncated,
        reasonCode: code || null,
      };
    }

    case "step/start":
    case "step/end":
      return {
        ...base("step"),
        turn: eventTurn ?? turn,
        step,
        phase: type === "step/start" ? "start" : "end",
      };

    case "session/title": {
      const title = nonEmptyString(data.title);
      if (!title) return null;
      return { ...base("title"), title: clip(title, LIMITS.title).text };
    }

    case "user/message": {
      const parts = contentParts(data.content);
      if (parts.text.length === 0 && parts.images === 0) return null;
      const text = clip(parts.text, LIMITS.user);
      return {
        ...base("user"),
        text: text.text,
        truncated: text.truncated,
        fullLength: text.length,
        images: parts.images,
        from: nonEmptyString(data.source?.kind) || "user",
      };
    }

    case "assistant/message": {
      const parts = contentParts(data.message?.content);
      if (parts.text.trim().length === 0 && parts.reasoning.trim().length === 0) return null;
      const text = clip(parts.text, LIMITS.assistant);
      const reasoning = clip(parts.reasoning, LIMITS.reasoning);
      return {
        ...base("assistant"),
        text: text.text,
        textTruncated: text.truncated,
        textLength: text.length,
        reasoning: reasoning.text,
        reasoningTruncated: reasoning.truncated,
        reasoningLength: reasoning.length,
        images: parts.images,
        model: nonEmptyString(data.message?.source?.model) || null,
        tokens: Number.isFinite(data.usage?.totalTokens) ? data.usage.totalTokens : null,
      };
    }

    case "tool/call": {
      const rawArguments = typeof data.arguments === "string" ? data.arguments : "";
      const args = parseArguments(rawArguments);
      const name = nonEmptyString(data.name) || "tool";
      return {
        ...base("tool_call"),
        callId: nonEmptyString(data.callId) || null,
        name,
        summary: summarizeTool(name, args, rawArguments),
        input: toolInput(name, args, rawArguments),
      };
    }

    case "tool/result": {
      const parts = contentParts(data.message?.content);
      const text = parts.text.length > 0
        ? parts.text
        : parts.images > 0
          ? `[${parts.images} imagem(ns)]`
          : "[sem saída textual]";
      const output = clip(text, LIMITS.toolOutput);
      return {
        ...base("tool_result"),
        callId: nonEmptyString(data.message?.toolCallId)
          || nonEmptyString(data.message?.source?.callId)
          || null,
        isError: data.message?.isError === true,
        output: output.text,
        truncated: output.truncated,
        outputLength: output.length,
        images: parts.images,
      };
    }

    default:
      return null;
  }
}

/**
 * @param {object} event
 * @returns {number|null}
 */
export function eventSeq(event) {
  return Number.isInteger(event?.seq) ? event.seq : null;
}

/**
 * @param {object} event
 * @returns {number|null}
 */
export function eventTime(event) {
  return Number.isFinite(event?.time) ? event.time : null;
}

/**
 * Cabeçalho da sessão, lido do primeiro evento `session`.
 * @param {object[]} events
 * @returns {{id: string|null, cwd: string|null, createdAt: number|null}|null}
 */
export function extractHeader(events) {
  for (const event of events) {
    if (event?.type !== "session") continue;
    return {
      id: nonEmptyString(event.id) || null,
      cwd: nonEmptyString(event.cwd) || null,
      createdAt: Number.isFinite(event.createdAt) ? event.createdAt : null,
    };
  }
  return null;
}

/**
 * Último título registrado; se não houver, deriva da primeira mensagem do usuário.
 * @param {object[]} events
 * @returns {string|null}
 */
export function extractTitle(events) {
  let title = null;
  let firstUserText = null;
  for (const event of events) {
    if (event?.type === "session/title" && typeof event.data?.title === "string") {
      const candidate = event.data.title.trim();
      if (candidate.length > 0) title = candidate;
    } else if (event?.type === "user/message" && firstUserText === null) {
      const parts = contentParts(event.data?.content);
      const candidate = oneLine(parts.text, 120);
      if (candidate.length > 0) firstUserText = candidate;
    }
  }
  return clip(title ?? firstUserText ?? "", LIMITS.title).text || null;
}
