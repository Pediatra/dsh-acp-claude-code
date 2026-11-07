/**
 * Leitor tolerante do log de sessão do DSH.
 *
 * O arquivo `session.v4.jsonl.zstd` é uma concatenação de frames zstd
 * completos. O último frame pode estar pela metade enquanto o writer grava.
 * `ZSTD_e_flush` devolve todo o prefixo decodificável e ignora o final
 * incompleto; se o decoder síncrono ainda assim recusar o buffer, tentamos o
 * mesmo decode em streaming para recuperar o prefixo anterior ao erro.
 *
 * Nada aqui escreve em disco.
 */
import zlib from "node:zlib";

const INCOMPLETE_FRAME_OPTIONS = Object.freeze({
  finishFlush: zlib.constants.ZSTD_e_flush,
});

/**
 * Decoda um buffer zstd possivelmente truncado.
 * @param {Buffer} buffer bytes atuais do log.
 * @returns {Promise<{text: string, error: Error|null, recovered: boolean}>}
 *   `text` é sempre uma string; `error` só é preenchido quando o decode
 *   precisou do fallback ou falhou. `recovered` indica que o fallback
 *   conseguiu produzir algum prefixo.
 */
export async function decodeZstdBuffer(buffer) {
  if (buffer.length === 0) return { text: "", error: null, recovered: false };

  try {
    const text = zlib
      .zstdDecompressSync(buffer, INCOMPLETE_FRAME_OPTIONS)
      .toString("utf8");
    return { text, error: null, recovered: false };
  } catch (error) {
    const fallback = await decodeStreaming(buffer);
    if (fallback.text.length > 0) {
      return { text: fallback.text, error, recovered: true };
    }
    return { text: "", error: fallback.error ?? error, recovered: false };
  }
}

/**
 * Fallback por streaming: guarda os chunks já produzidos e devolve o prefixo
 * mesmo quando o decoder encontra um erro no meio.
 * @param {Buffer} buffer bytes do log.
 * @returns {Promise<{text: string, error: Error|null}>}
 */
function decodeStreaming(buffer) {
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      resolve({
        text: Buffer.concat(chunks).toString("utf8"),
        error: error ?? null,
      });
    };

    let decoder;
    try {
      decoder = zlib.createZstdDecompress(INCOMPLETE_FRAME_OPTIONS);
    } catch (error) {
      settle(error);
      return;
    }

    decoder.on("data", (chunk) => chunks.push(chunk));
    decoder.on("error", (error) => settle(error));
    decoder.on("end", () => settle(null));
    decoder.on("close", () => {
      if (!settled) settle(null);
    });

    try {
      decoder.end(buffer);
    } catch (error) {
      settle(error);
    }
  });
}

/**
 * Separa o texto em eventos JSON completos. Uma última linha sem newline só é
 * aceita se já for um JSON válido; caso contrário é considerada em escrita e
 * descartada até a próxima leitura. Linhas quebradas são contadas e ignoradas.
 *
 * @param {string} text texto decodificado.
 * @returns {{events: object[], badLines: number, partialLine: boolean, lineCount: number}}
 */
export function parseEventLines(text) {
  const events = [];
  let badLines = 0;
  let partialLine = false;
  if (text.length === 0) {
    return { events, badLines, partialLine, lineCount: 0 };
  }

  const parts = text.split("\n");
  let tail = "";
  if (text.endsWith("\n")) {
    parts.pop();
  } else {
    tail = parts.pop() ?? "";
  }

  for (const line of parts) {
    if (line.trim().length === 0) continue;
    const event = parseEventLine(line);
    if (event === null) badLines += 1;
    else events.push(event);
  }

  if (tail.length > 0) {
    const event = parseEventLine(tail);
    if (event === null) partialLine = true;
    else events.push(event);
  }

  return { events, badLines, partialLine, lineCount: events.length + badLines };
}

/**
 * @param {string} line
 * @returns {object|null}
 */
function parseEventLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.type !== "string" || value.type.length === 0) return null;
  return value;
}

/**
 * Resumo curto e sem stack de um erro de decode, para exibir na UI.
 * @param {unknown} error
 * @returns {string|null}
 */
export function describeDecodeError(error) {
  if (error === null || error === undefined) return null;
  if (error instanceof Error) {
    const code = typeof error.code === "string" ? `${error.code}: ` : "";
    const message = error.message || "erro de decodificação";
    return `${code}${message}`.slice(0, 240);
  }
  return String(error).slice(0, 240);
}
