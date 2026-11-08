window.__ModuleLoader__.load({
  id: "@local/dsh-visor",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    const NS = "visor-dsh";
    const PANEL_ID = "visor-dsh";
    const API = "/api/visor";
    const SELECTED_KEY = "visor-dsh:selected";

    const en = {
      "panel.label": "Session viewer",
      "title": "Session viewer",
      "subtitle": "Follow persisted DSH sessions without touching their lock.",
      "list.title": "Sessions",
      "list.count": "Sessions: {count}",
      "list.search": "Filter by directory, title or id",
      "list.refresh": "Refresh",
      "list.loading": "Loading sessions…",
      "list.empty": "No sessions found.",
      "list.emptyHint": "The viewer looks for <DSH_HOME>/sessions/*/*/.",
      "list.error": "Could not list sessions.",
      "filter.acpOnly": "Only external owner: dsh acp",
      "filter.showAll": "Show all sessions",
      "filter.emptyAcp": "No session with external owner dsh acp right now.",
      "filter.emptyAcpHint": "The ACP bridge may be starting or between turns. Show all to browse the persisted sessions.",
      "list.noLog": "no log yet",
      "list.owner": "owner {pid}",
      "list.live": "live",
      "status.live": "Live",
      "status.stopped": "Stopped",
      "status.ownerSelf": "Owner: this dsh web (PID {pid})",
      "status.ownerExternal": "External owner: {label} (PID {pid})",
      "status.noOwner": "No owner",
      "status.lockUnheld": "Lock present, no holder",
      "status.connecting": "Reconnecting…",
      "status.readError": "Partial read",
      "status.truncated": "Truncated log",
      "status.partial": "Line being written",
      "meta.cwd": "Directory",
      "meta.id": "Session id",
      "meta.size": "Log",
      "meta.events": "{count} events",
      "meta.updated": "Updated {time}",
      "meta.lastEvent": "Last event {time}",
      "action.jumpEnd": "Jump to the end",
      "action.retry": "Try again",
      "action.copyId": "Copy id",
      "action.copied": "Copied",
      "empty.chooseTitle": "Choose a session",
      "empty.chooseBody": "The list on the left shows the persisted sessions. Selecting one never opens or locks it.",
      "empty.sessionTitle": "Empty session",
      "empty.sessionBody": "This session has no events yet. If a process owns it, its turn will appear here as soon as it is written.",
      "empty.noLogTitle": "No log yet",
      "empty.noLogBody": "This session directory exists but its session.v4.jsonl.zstd has not been materialized. The viewer will keep trying without writing anything.",
      "empty.waitingOwner": "The lock is held by {label} (PID {pid}); the log is the only source this viewer reads.",
      "feed.error": "Could not read this session.",
      "feed.loading": "Reading session…",
      "feed.retry": "Retry read",
      "turn.pre": "Before the first turn",
      "turn.title": "Turn {number}",
      "turn.running": "running",
      "turn.completed": "completed",
      "turn.interrupted": "interrupted",
      "turn.aborted": "aborted",
      "turn.error": "error",
      "turn.openStopped": "open / stopped",
      "turn.open": "open",
      "turn.ended": "ended",
      "turn.step": "step {step}",
      "turn.interruptedDetail": "This turn ended with reason \"interrupted\" because the DSH process exited before the turn finished. The next turn will appear as a new block; this record is intentional.",
      "turn.completedDetail": "Turn finished.",
      "turn.abortedDetail": "Turn aborted ({reason}).",
      "turn.errorDetail": "Turn ended with an error: {detail}",
      "turn.genericDetail": "Turn ended with reason {reason}.",
      "user.label": "User",
      "user.agent": "Agent",
      "assistant.label": "Assistant",
      "assistant.thinking": "Reasoning",
      "assistant.tokens": "{count} tokens",
      "tool.waiting": "waiting for result…",
      "tool.input": "Input",
      "tool.output": "Output",
      "tool.error": "error",
      "tool.ok": "ok",
      "tool.truncated": "truncated · {count} characters",
      "tool.noOutput": "[no textual output]",
      "images.note": "{count} image(s)",
      "notice.degraded": "The decoder recovered only a prefix of the log. The last good state is kept and reading resumes when the file grows.",
    };

    const pt = {
      "panel.label": "Visor de sessões",
      "title": "Visor de sessões",
      "subtitle": "Acompanhe sessões persistidas do DSH sem tocar no lock delas.",
      "list.title": "Sessões",
      "list.count": "Sessões: {count}",
      "list.search": "Filtrar por diretório, título ou id",
      "list.refresh": "Atualizar",
      "list.loading": "Carregando sessões…",
      "list.empty": "Nenhuma sessão encontrada.",
      "list.emptyHint": "O visor procura em <DSH_HOME>/sessions/*/*/.",
      "list.error": "Não foi possível listar as sessões.",
      "filter.acpOnly": "Só dono externo: dsh acp",
      "filter.showAll": "Mostrar todas as sessões",
      "filter.emptyAcp": "Nenhuma sessão com dono externo dsh acp agora.",
      "filter.emptyAcpHint": "A ponte ACP pode estar iniciando ou entre turnos. Mostre todas para navegar pelas sessões persistidas.",
      "list.noLog": "sem log ainda",
      "list.owner": "dono {pid}",
      "list.live": "ao vivo",
      "status.live": "Ao vivo",
      "status.stopped": "Parado",
      "status.ownerSelf": "Dono: este dsh web (PID {pid})",
      "status.ownerExternal": "Dono externo: {label} (PID {pid})",
      "status.noOwner": "Sem dono",
      "status.lockUnheld": "Lock presente, sem dono",
      "status.connecting": "Reconectando…",
      "status.readError": "Leitura parcial",
      "status.truncated": "Log truncado",
      "status.partial": "Linha em escrita",
      "meta.cwd": "Diretório",
      "meta.id": "Id da sessão",
      "meta.size": "Log",
      "meta.events": "{count} eventos",
      "meta.updated": "Atualizado {time}",
      "meta.lastEvent": "Último evento {time}",
      "action.jumpEnd": "Ir para o fim",
      "action.retry": "Tentar de novo",
      "action.copyId": "Copiar id",
      "action.copied": "Copiado",
      "empty.chooseTitle": "Escolha uma sessão",
      "empty.chooseBody": "A lista à esquerda mostra as sessões persistidas. Selecionar uma nunca a abre nem toma o lock.",
      "empty.sessionTitle": "Sessão vazia",
      "empty.sessionBody": "Esta sessão ainda não tem eventos. Se um processo é dono dela, o turno aparece aqui assim que for gravado.",
      "empty.noLogTitle": "Sem log ainda",
      "empty.noLogBody": "O diretório da sessão existe, mas o session.v4.jsonl.zstd ainda não foi materializado. O visor continua tentando sem escrever nada.",
      "empty.waitingOwner": "O lock está com {label} (PID {pid}); o visor lê apenas o log.",
      "feed.error": "Não foi possível ler esta sessão.",
      "feed.loading": "Lendo a sessão…",
      "feed.retry": "Tentar leitura de novo",
      "turn.pre": "Antes do primeiro turno",
      "turn.title": "Turno {number}",
      "turn.running": "em andamento",
      "turn.completed": "concluído",
      "turn.interrupted": "interrompido",
      "turn.aborted": "abortado",
      "turn.error": "erro",
      "turn.openStopped": "aberto / parado",
      "turn.open": "aberto",
      "turn.ended": "encerrado",
      "turn.step": "passo {step}",
      "turn.interruptedDetail": "Este turno terminou com motivo \"interrupted\" porque o processo DSH encerrou antes de concluí-lo. O próximo turno aparece como um bloco novo; este registro é intencional e não é um banner eterno.",
      "turn.completedDetail": "Turno concluído.",
      "turn.abortedDetail": "Turno abortado ({reason}).",
      "turn.errorDetail": "Turno encerrado com erro: {detail}",
      "turn.genericDetail": "Turno encerrado com motivo {reason}.",
      "user.label": "Usuário",
      "user.agent": "Agente",
      "assistant.label": "Assistente",
      "assistant.thinking": "Raciocínio",
      "assistant.tokens": "{count} tokens",
      "tool.waiting": "aguardando resultado…",
      "tool.input": "Entrada",
      "tool.output": "Saída",
      "tool.error": "erro",
      "tool.ok": "ok",
      "tool.truncated": "truncada · {count} caracteres",
      "tool.noOutput": "[sem saída textual]",
      "images.note": "{count} imagem(ns)",
      "notice.degraded": "O decoder recuperou apenas um prefixo do log. O último estado bom é mantido e a leitura continua quando o arquivo crescer.",
    };

    const css = `
      .visor-root {
        box-sizing: border-box;
        display: flex;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-base);
        font-size: 14px;
        line-height: 1.6;
      }
      .visor-root *, .visor-root *::before, .visor-root *::after { box-sizing: border-box; }
      .visor-root button, .visor-root input { font: inherit; }
      .visor-root :focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .visor-side {
        display: flex;
        flex: 0 0 326px;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
        border-right: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-specific-sidebar-fill);
      }
      .visor-side-head { padding: 20px 16px 12px; }
      .visor-side-head h1 { margin: 0; font-size: 16px; font-weight: 600; line-height: 24px; }
      .visor-side-head p { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
      .visor-side-tools { display: flex; gap: 8px; align-items: center; padding: 0 16px 10px; }
      .visor-filter-row {
        display: flex; align-items: center; gap: 8px;
        padding: 0 16px 10px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 17px;
      }
      .visor-filter-row label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
      .visor-filter-row input { width: 13px; height: 13px; margin: 0; accent-color: var(--dsw-alias-brand-primary); }
      .visor-search {
        flex: 1; min-width: 0; height: 32px; padding: 0 10px;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 9px; outline: none;
      }
      .visor-search::placeholder { color: var(--dsw-alias-label-secondary); opacity: .8; }
      .visor-search:focus { border-color: var(--dsw-alias-brand-primary); }
      .visor-button {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        height: 30px; padding: 0 10px; cursor: pointer;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 9px; white-space: nowrap; font-size: 12px;
      }
      .visor-button:hover { background: var(--dsw-alias-bg-layer-2); }
      .visor-button:disabled { cursor: default; opacity: .55; }
      .visor-button.is-quiet { background: transparent; }
      .visor-side-scroll { flex: 1; min-height: 0; overflow: auto; padding: 2px 8px 24px; }
      .visor-side-count { padding: 0 10px 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .visor-session {
        display: flex; flex-direction: column; gap: 2px; width: 100%;
        padding: 8px 10px; margin: 1px 0; text-align: left; cursor: pointer;
        color: inherit; background: transparent; border: 1px solid transparent; border-radius: 10px;
      }
      .visor-session:hover { background: var(--dsw-alias-bg-layer-2); }
      .visor-session.is-selected { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
      .visor-session-title {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-size: 13px; font-weight: 600; line-height: 19px;
      }
      .visor-session-path {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 17px;
      }
      .visor-session-meta {
        display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px;
        color: var(--dsw-alias-label-secondary); font-size: 10.5px; line-height: 15px;
      }
      .visor-session-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; opacity: .8; }
      .visor-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-secondary); flex: none; }
      .visor-dot.is-live { background: var(--dsw-alias-state-success-primary); animation: visor-pulse 1.8s ease-in-out infinite; }
      .visor-dot.is-owner { background: var(--dsw-alias-state-warn-primary); }
      .visor-main { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
      .visor-header {
        display: flex; flex-direction: column; gap: 6px;
        padding: 18px 24px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1);
        background: var(--dsw-alias-bg-base);
      }
      .visor-header-top { display: flex; align-items: flex-start; gap: 14px; }
      .visor-title-block { flex: 1; min-width: 0; }
      .visor-title-block h2 {
        margin: 0; overflow-wrap: anywhere;
        font-size: 18px; font-weight: 600; line-height: 25px;
      }
      .visor-subline {
        display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;
        margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 18px;
      }
      .visor-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .visor-badges { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
      .visor-badge {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 2px 8px; border-radius: 999px;
        color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1);
        font-size: 11px; line-height: 17px; white-space: nowrap;
      }
      .visor-badge.is-live { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .visor-badge.is-stopped { color: var(--dsw-alias-label-secondary); }
      .visor-badge.is-owner { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .visor-badge.is-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .visor-badge.is-idle { color: var(--dsw-alias-state-idle-primary); border-color: var(--dsw-alias-state-idle-primary); }
      .visor-notice {
        margin: 8px 0 0; padding: 8px 11px; border-radius: 10px;
        color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1);
        font-size: 12px; line-height: 19px;
      }
      .visor-notice.is-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .visor-notice.is-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .visor-timeline-wrap { position: relative; display: flex; flex: 1; min-height: 0; }
      .visor-timeline { flex: 1; min-height: 0; overflow: auto; padding: 16px 24px 90px; }
      .visor-timeline-inner { width: 100%; max-width: 1000px; margin: 0 auto; }
      .visor-turn { margin: 0 0 20px; }
      .visor-turn-head {
        display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
        padding: 4px 0 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); margin-bottom: 8px;
      }
      .visor-turn-head h3 { margin: 0; font-size: 13px; font-weight: 600; line-height: 20px; }
      .visor-turn-head .visor-badge { font-size: 10.5px; }
      .visor-turn-step { margin-left: auto; color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .visor-item { margin: 8px 0; }
      .visor-message { display: flex; gap: 10px; align-items: flex-start; }
      .visor-avatar {
        display: flex; align-items: center; justify-content: center; flex: none;
        width: 24px; height: 24px; margin-top: 2px; border-radius: 50%;
        color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
        font-size: 10px; font-weight: 600;
      }
      .visor-message-body { flex: 1; min-width: 0; }
      .visor-message-label {
        display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px;
        margin-bottom: 2px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 17px;
      }
      .visor-user-bubble {
        padding: 8px 11px; border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1);
        white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px; line-height: 21px;
      }
      .visor-assistant-text {
        white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13.5px; line-height: 21px;
      }
      .visor-muted { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
      .visor-thinking { margin-top: 5px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .visor-thinking summary { cursor: pointer; width: fit-content; }
      .visor-thinking pre {
        margin: 6px 0 0; padding: 8px 10px; max-height: 230px; overflow: auto;
        white-space: pre-wrap; overflow-wrap: anywhere;
        background: var(--dsw-alias-bg-layer-1);
        border-left: 2px solid var(--dsw-alias-border-l2); border-radius: 0 8px 8px 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 17px;
      }
      .visor-tool {
        margin: 8px 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1); overflow: hidden;
      }
      .visor-tool summary {
        display: flex; align-items: center; gap: 8px;
        padding: 7px 10px; cursor: pointer; list-style: none;
      }
      .visor-tool summary::-webkit-details-marker { display: none; }
      .visor-tool[open] summary { border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .visor-tool-name {
        flex: none; padding: 1px 6px; border-radius: 6px;
        color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; font-weight: 600;
      }
      .visor-tool-summary {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--dsw-alias-label-secondary); font-size: 12px;
      }
      .visor-tool-state { flex: none; color: var(--dsw-alias-label-secondary); font-size: 10px; }
      .visor-tool-state.is-error { color: var(--dsw-alias-state-error-primary); }
      .visor-tool-body { display: flex; flex-direction: column; gap: 7px; padding: 9px 10px 10px; }
      .visor-tool-label { color: var(--dsw-alias-label-secondary); font-size: 10px; letter-spacing: .04em; text-transform: uppercase; }
      .visor-tool pre {
        margin: 0; padding: 7px 9px; max-height: 300px; overflow: auto;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
        white-space: pre-wrap; overflow-wrap: anywhere;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 17px;
      }
      .visor-tool pre.is-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .visor-tool-waiting { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
      .visor-turn-end {
        margin: 9px 0 0; padding: 7px 11px; border-radius: 9px;
        color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1);
        border: 1px solid var(--dsw-alias-border-l1); font-size: 12px; line-height: 19px;
      }
      .visor-turn-end strong { font-weight: 600; }
      .visor-turn-end.is-interrupted, .visor-turn-end.is-aborted {
        color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary);
      }
      .visor-turn-end.is-error {
        color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary);
      }
      .visor-turn-end .visor-mono { font-size: 11px; }
      .visor-empty {
        display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center;
        gap: 6px; padding: 40px 24px; text-align: center; color: var(--dsw-alias-label-secondary);
      }
      .visor-empty h3 { margin: 0; color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600; }
      .visor-empty p { max-width: 560px; margin: 0; font-size: 12.5px; line-height: 20px; }
      .visor-empty .visor-button { margin-top: 8px; }
      .visor-jump {
        position: absolute; right: 22px; bottom: 18px; z-index: 2;
        box-shadow: 0 4px 18px color-mix(in srgb, var(--dsw-alias-bg-base) 45%, transparent);
      }
      .visor-spinner {
        width: 18px; height: 18px; border-radius: 50%;
        border: 2px solid var(--dsw-alias-border-l2);
        border-top-color: var(--dsw-alias-brand-primary);
        animation: visor-spin .8s linear infinite;
      }
      @keyframes visor-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
      @keyframes visor-spin { to { transform: rotate(360deg); } }
      @media (max-width: 860px) {
        .visor-root { flex-direction: column; }
        .visor-side { flex: 0 0 auto; max-height: 38%; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
        .visor-header { padding: 14px 16px 10px; }
        .visor-timeline { padding: 12px 16px 80px; }
      }
      @media (prefers-reduced-motion: reduce) {
        .visor-dot.is-live, .visor-spinner { animation: none; }
      }
    `;

    /**
     * @param {string} url
     * @param {AbortSignal} signal
     */
    async function fetchJson(url, signal) {
      const response = await fetch(url, {
        signal,
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        // resposta sem JSON (por exemplo 401 em texto puro)
      }
      if (!response.ok) {
        const error = new Error(body?.error ?? `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return body ?? {};
    }

    /**
     * @param {object[]} previous
     * @param {object[]} incoming
     * @returns {object[]}
     */
    function mergeItems(previous, incoming) {
      if (!Array.isArray(incoming) || incoming.length === 0) return previous;
      const seen = new Set(previous.map((item) => item.seq));
      const additions = incoming.filter((item) => item.seq === null || !seen.has(item.seq));
      return additions.length === 0 ? previous : previous.concat(additions);
    }

    /**
     * @param {object[]} items
     * @returns {object[]}
     */
    function groupItems(items) {
      const turns = [];
      const byNumber = new Map();
      let current = 0;

      const ensure = (number) => {
        const key = Number.isInteger(number) ? number : 0;
        let turn = byNumber.get(key);
        if (turn === undefined) {
          turn = {
            number: key,
            items: [],
            step: null,
            stepPhase: null,
            start: null,
            end: null,
            calls: new Set(),
            results: new Map(),
          };
          byNumber.set(key, turn);
          turns.push(turn);
        }
        return turn;
      };

      for (const item of items) {
        if (item.kind === "title") continue;
        if (item.kind === "turn_start") {
          current = Number.isInteger(item.turn) ? item.turn : current;
          const turn = ensure(current);
          turn.start = item;
          turn.items.push(item);
          continue;
        }
        if (item.kind === "step") {
          const turn = ensure(item.turn ?? current);
          if (Number.isInteger(item.step)) {
            turn.step = item.step;
            turn.stepPhase = item.phase;
          }
          continue;
        }
        if (item.kind === "turn_end") {
          const turn = ensure(item.turn ?? current);
          turn.end = item;
          continue;
        }
        const turn = ensure(item.turn ?? current);
        turn.items.push(item);
      }

      for (const turn of turns) {
        for (const item of turn.items) {
          if (item.kind === "tool_call" && item.callId) turn.calls.add(item.callId);
          else if (item.kind === "tool_result" && item.callId) turn.results.set(item.callId, item);
        }
      }
      return turns;
    }

    /** @param {string} kind */
    function turnState(kind) {
      if (kind === "completed" || kind === "interrupted" || kind === "aborted" || kind === "error") return kind;
      return "ended";
    }

    /** @param {string} status */
    function statusKey(status) {
      return `turn.${status}`;
    }

    /**
     * @param {number|null|undefined} value
     * @param {object} [options]
     */
    function formatTime(value, options) {
      if (!Number.isFinite(value)) return "—";
      try {
        return new Intl.DateTimeFormat(undefined, options ?? {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(new Date(value));
      } catch {
        return new Date(value).toLocaleTimeString();
      }
    }

    /** @param {number|null|undefined} value */
    function formatBytes(value) {
      if (!Number.isFinite(value)) return "—";
      if (value < 1024) return `${value} B`;
      const units = ["KB", "MB", "GB"];
      let size = value / 1024;
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return `${size.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[index]}`;
    }

    /**
     * @param {number|null|undefined} value
     * @param {(key: string, params?: object) => string} t
     */
    function formatRelative(value, t) {
      if (!Number.isFinite(value)) return "";
      const delta = value - Date.now();
      const abs = Math.abs(delta);
      let unit = "second";
      let amount = Math.round(delta / 1000);
      if (abs >= 86_400_000) {
        unit = "day";
        amount = Math.round(delta / 86_400_000);
      } else if (abs >= 3_600_000) {
        unit = "hour";
        amount = Math.round(delta / 3_600_000);
      } else if (abs >= 60_000) {
        unit = "minute";
        amount = Math.round(delta / 60_000);
      }
      try {
        return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(amount, unit);
      } catch {
        return formatTime(value);
      }
    }

    /** @param {string} id */
    function shortId(id) {
      return typeof id === "string" && id.length > 12 ? id.slice(0, 8) : id;
    }

    /**
     * @param {object[]|null|undefined} owner
     * @param {number|null|undefined} hostPid
     */
    /** Sessão cujo lock está com um processo ACP externo (outro processo). */
    function isExternalAcpOwner(session, hostPid) {
      if (!Array.isArray(session.owner)) return false;
      return session.owner.some((item) =>
        item !== null && typeof item === "object"
        && item.label === "dsh acp"
        && item.pid !== hostPid,
      );
    }

    function ownerSummary(owner, hostPid) {
      if (!Array.isArray(owner) || owner.length === 0) return null;
      const external = owner.filter((item) => item.pid !== hostPid);
      const self = owner.find((item) => item.pid === hostPid);
      if (external.length > 0) {
        const first = external[0];
        return {
          kind: "external",
          label: first.label || first.comm || "process",
          pid: first.pid,
          count: external.length,
          all: external,
        };
      }
      return {
        kind: "self",
        label: self?.label || self?.comm || "dsh web",
        pid: self?.pid ?? hostPid,
        count: owner.length,
        all: owner,
      };
    }

    function useSessions() {
      const [state, setState] = React.useState({
        status: "loading",
        sessions: [],
        root: null,
        hostPid: null,
        error: null,
      });
      const tick = React.useCallback(async (signal) => {
        try {
          const data = await fetchJson(`${API}/sessions`, signal);
          setState({
            status: "ready",
            sessions: Array.isArray(data.sessions) ? data.sessions : [],
            root: typeof data.root === "string" ? data.root : null,
            hostPid: Number.isInteger(data.hostPid) ? data.hostPid : null,
            error: null,
          });
        } catch (error) {
          if (error?.name === "AbortError") return;
          setState((previous) => ({
            ...previous,
            status: previous.sessions.length > 0 ? "ready" : "error",
            error: error?.message ? String(error.message) : String(error),
          }));
        }
      }, []);

      React.useEffect(() => {
        const controller = new AbortController();
        let stopped = false;
        let timer = null;
        const run = () => {
          if (stopped || document.hidden) return;
          tick(controller.signal);
        };
        run();
        timer = window.setInterval(run, 5000);
        const onVisibility = () => {
          if (!document.hidden) run();
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
          stopped = true;
          controller.abort();
          if (timer !== null) window.clearInterval(timer);
          document.removeEventListener("visibilitychange", onVisibility);
        };
      }, [tick]);

      return [state, tick];
    }

    /**
     * @param {string|null} sessionId
     */
    function useFeed(sessionId, reloadToken) {
      const [state, setState] = React.useState({
        items: [],
        meta: null,
        error: null,
        loading: false,
      });
      const cursor = React.useRef({ afterSeq: null, generation: null });

      React.useEffect(() => {
        setState({ items: [], meta: null, error: null, loading: Boolean(sessionId) });
        cursor.current = { afterSeq: null, generation: null };
        if (!sessionId) return undefined;

        const controller = new AbortController();
        let stopped = false;
        let inFlight = false;
        let timer = null;

        const tick = async () => {
          if (stopped || inFlight || document.hidden) return;
          inFlight = true;
          try {
            const params = new URLSearchParams({ id: sessionId });
            if (cursor.current.afterSeq !== null) {
              params.set("afterSeq", String(cursor.current.afterSeq));
            }
            if (cursor.current.generation !== null) {
              params.set("gen", String(cursor.current.generation));
            }
            const data = await fetchJson(`${API}/session?${params.toString()}`, controller.signal);
            if (stopped) return;
            const meta = data.meta ?? null;
            cursor.current = {
              afterSeq: meta !== null && Number.isInteger(meta.lastSeq) && meta.lastSeq >= 0
                ? meta.lastSeq
                : null,
              generation: meta !== null && Number.isInteger(meta.generation) ? meta.generation : null,
            };
            setState((previous) => {
              const items = data.reset === true
                ? (Array.isArray(data.items) ? data.items : [])
                : mergeItems(previous.items, Array.isArray(data.items) ? data.items : []);
              return { items, meta, error: null, loading: false };
            });
          } catch (error) {
            if (stopped || error?.name === "AbortError") return;
            setState((previous) => ({
              ...previous,
              error: error?.message ? String(error.message) : String(error),
              loading: false,
            }));
          } finally {
            inFlight = false;
          }
        };

        tick();
        timer = window.setInterval(tick, 1000);
        const onVisibility = () => {
          if (!document.hidden) tick();
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
          stopped = true;
          controller.abort();
          if (timer !== null) window.clearInterval(timer);
          document.removeEventListener("visibilitychange", onVisibility);
        };
      }, [sessionId, reloadToken]);

      return state;
    }

    function Badge({ tone, children, title }) {
      return h("span", { className: `visor-badge ${tone ? `is-${tone}` : ""}`, title }, children);
    }

    function LiveBadge({ live, t }) {
      return h(Badge, { tone: live ? "live" : "stopped" },
        h("span", { className: `visor-dot ${live ? "is-live" : ""}`, "aria-hidden": "true" }),
        live ? t("status.live") : t("status.stopped"),
      );
    }

    function OwnerBadge({ meta, t }) {
      if (!meta) return null;
      const summary = ownerSummary(meta.owner, meta.hostPid);
      if (summary !== null) {
        if (summary.kind === "self") {
          return h(Badge, {
            tone: "owner",
            title: summary.all.map((item) => `${item.label} (${item.pid})`).join(", "),
          }, t("status.ownerSelf", { pid: summary.pid }));
        }
        return h(Badge, {
          tone: "owner",
          title: summary.all.map((item) => `${item.label} (${item.pid})`).join(", "),
        }, t("status.ownerExternal", { label: summary.label, pid: summary.pid }));
      }
      if (meta.lockExists) return h(Badge, { tone: "idle" }, t("status.lockUnheld"));
      return h(Badge, { tone: "idle" }, t("status.noOwner"));
    }

    function SessionRow({ session, selected, onSelect, t }) {
      const owner = Array.isArray(session.owner) && session.owner.length > 0 ? session.owner[0] : null;
      const title = session.title || session.cwd || shortId(session.id);
      return h("button", {
        type: "button",
        className: `visor-session ${selected ? "is-selected" : ""}`,
        onClick: () => onSelect(session.id),
        "aria-current": selected ? "page" : undefined,
        title: `${session.id}\n${session.cwd ?? ""}`,
      },
      h("span", { className: "visor-session-title" }, title),
      h("span", { className: "visor-session-path" }, session.cwd ?? session.dirName),
      h("span", { className: "visor-session-meta" },
        h("span", { className: "visor-session-id" }, shortId(session.id)),
        h("span", null, formatRelative(session.mtimeMs, t)),
        h("span", null, formatBytes(session.logSize)),
        session.live
          ? h("span", { className: "visor-dot is-live", "aria-label": t("list.live") })
          : null,
        owner
          ? h("span", { className: "visor-dot is-owner", "aria-label": t("list.owner", { pid: owner.pid }) })
          : null,
        !session.hasLog
          ? h("span", { className: "visor-muted" }, t("list.noLog"))
          : null,
      ));
    }

    function ToolCard({ item, result, t, live }) {
      const isError = result?.isError === true;
      const stateLabel = isError ? t("tool.error") : t("tool.ok");
      return h("details", { className: "visor-tool" },
        h("summary", null,
          h("span", { className: "visor-tool-name" }, item.name),
          h("span", { className: "visor-tool-summary", title: item.summary }, item.summary),
          result
            ? h("span", { className: `visor-tool-state ${isError ? "is-error" : ""}` }, stateLabel)
            : h("span", { className: "visor-tool-state" }, live ? "…" : "—"),
        ),
        h("div", { className: "visor-tool-body" },
          h("div", { className: "visor-tool-label" }, t("tool.input")),
          h("pre", null, item.input),
          result
            ? h(React.Fragment, null,
              h("div", { className: "visor-tool-label" }, t("tool.output")),
              h("pre", { className: isError ? "is-error" : undefined }, result.output),
              result.truncated
                ? h("div", { className: "visor-muted" }, t("tool.truncated", { count: result.outputLength }))
                : null,
              result.images > 0
                ? h("div", { className: "visor-muted" }, t("images.note", { count: result.images }))
                : null,
            )
            : h("div", { className: "visor-tool-waiting" }, live ? t("tool.waiting") : "—"),
        ),
      );
    }

    function UserMessage({ item, t }) {
      const label = item.from === "agent" ? t("user.agent") : t("user.label");
      return h("div", { className: "visor-message visor-item" },
        h("div", { className: "visor-avatar", "aria-hidden": "true" }, "U"),
        h("div", { className: "visor-message-body" },
          h("div", { className: "visor-message-label" },
            h("strong", null, label),
            h("span", null, formatTime(item.time)),
          ),
          h("div", { className: "visor-user-bubble" }, item.text),
          item.images > 0
            ? h("div", { className: "visor-muted" }, t("images.note", { count: item.images }))
            : null,
          item.truncated
            ? h("div", { className: "visor-muted" }, `… (${item.fullLength})`)
            : null,
        ),
      );
    }

    function AssistantMessage({ item, t }) {
      return h("div", { className: "visor-message visor-item" },
        h("div", { className: "visor-avatar", "aria-hidden": "true" }, "A"),
        h("div", { className: "visor-message-body" },
          h("div", { className: "visor-message-label" },
            h("strong", null, t("assistant.label")),
            h("span", null, formatTime(item.time)),
            item.tokens !== null && item.tokens !== undefined
              ? h("span", null, t("assistant.tokens", { count: item.tokens }))
              : null,
            item.model ? h("span", { className: "visor-mono" }, item.model) : null,
          ),
          item.text.length > 0
            ? h("div", { className: "visor-assistant-text" }, item.text)
            : null,
          item.reasoning.length > 0
            ? h("details", { className: "visor-thinking" },
              h("summary", null, t("assistant.thinking")),
              h("pre", null, item.reasoning),
              item.reasoningTruncated
                ? h("div", { className: "visor-muted" }, `… (${item.reasoningLength})`)
                : null,
            )
            : null,
          item.textTruncated
            ? h("div", { className: "visor-muted" }, `… (${item.textLength})`)
            : null,
        ),
      );
    }

    function TurnEnd({ turn, t }) {
      const end = turn.end;
      if (!end) return null;
      const state = turnState(end.reasonKind);
      const reason = end.reasonKind;
      const detail = end.reasonDetail;
      const suffix = end.reasonCode ? ` · ${end.reasonCode}` : "";
      let body;
      if (state === "interrupted") {
        body = h(React.Fragment, null,
          h("strong", null, t("turn.interrupted")),
          " — ",
          t("turn.interruptedDetail"),
        );
      } else if (state === "error") {
        body = h("strong", null, t("turn.errorDetail", { detail: detail || t("turn.error") }));
      } else if (state === "aborted") {
        body = h(React.Fragment, null,
          h("strong", null, t("turn.aborted")),
          " — ",
          t("turn.abortedDetail", { reason: detail || reason }),
        );
      } else if (state === "completed") {
        body = h(React.Fragment, null, h("strong", null, t("turn.completed")), " — ", t("turn.completedDetail"));
      } else {
        body = t("turn.genericDetail", { reason });
      }
      return h("div", { className: `visor-turn-end is-${state}`, title: `${reason}${suffix}` },
        body,
        end.reasonDetailTruncated ? h("div", { className: "visor-muted" }, "…") : null,
      );
    }

    function TurnBlock({ turn, isLast, live, t }) {
      const status = turn.end
        ? turnState(turn.end.reasonKind)
        : isLast
          ? live ? "running" : "openStopped"
          : "open";
      const step = Number.isInteger(turn.step) ? turn.step : null;
      const items = [];
      for (const item of turn.items) {
        if (item.kind === "user") {
          items.push(h(UserMessage, { key: `u-${item.seq}`, item, t }));
        } else if (item.kind === "assistant") {
          items.push(h(AssistantMessage, { key: `a-${item.seq}`, item, t }));
        } else if (item.kind === "tool_call") {
          const result = item.callId ? turn.results.get(item.callId) : undefined;
          items.push(h(ToolCard, { key: `t-${item.seq}`, item, result, t, live }));
        } else if (item.kind === "tool_result") {
          if (!item.callId || !turn.calls.has(item.callId)) {
            items.push(h("div", { key: `r-${item.seq}`, className: "visor-item" },
              h("div", { className: "visor-tool-label" }, t("tool.output")),
              h("pre", { className: item.isError ? "is-error" : undefined }, item.output),
            ));
          }
        }
      }

      return h("section", { className: "visor-turn", "aria-label": turn.number === 0 ? t("turn.pre") : t("turn.title", { number: turn.number }) },
        h("div", { className: "visor-turn-head" },
          h("h3", null, turn.number === 0 ? t("turn.pre") : t("turn.title", { number: turn.number })),
          h(Badge, { tone: status === "running" ? "live" : status === "error" ? "error" : status === "interrupted" || status === "aborted" ? "owner" : status === "completed" ? "live" : "stopped" },
            status === "running"
              ? h(React.Fragment, null, h("span", { className: "visor-dot is-live", "aria-hidden": "true" }), t(statusKey(status)))
              : t(statusKey(status)),
          ),
          step !== null
            ? h("span", { className: "visor-turn-step" }, t("turn.step", { step }))
            : null,
        ),
        items,
        h(TurnEnd, { turn, t }),
      );
    }

    function EmptyPane({ kind, meta, t, onRetry }) {
      if (kind === "choose") {
        return h("div", { className: "visor-empty" },
          h("h3", null, t("empty.chooseTitle")),
          h("p", null, t("empty.chooseBody")),
        );
      }
      if (kind === "loading") {
        return h("div", { className: "visor-empty" },
          h("div", { className: "visor-spinner", "aria-hidden": "true" }),
          h("h3", null, t("feed.loading")),
        );
      }
      if (kind === "error") {
        return h("div", { className: "visor-empty" },
          h("h3", null, t("feed.error")),
          h("p", { className: "visor-mono" }, meta ?? "—"),
          h("button", { type: "button", className: "visor-button", onClick: onRetry }, t("feed.retry")),
        );
      }
      if (kind === "no-log") {
        return h("div", { className: "visor-empty" },
          h("h3", null, t("empty.noLogTitle")),
          h("p", null, t("empty.noLogBody")),
        );
      }
      return h("div", { className: "visor-empty" },
        h("h3", null, t("empty.sessionTitle")),
        h("p", null, t("empty.sessionBody")),
        meta?.owner?.length > 0
          ? h("p", null, t("empty.waitingOwner", { label: meta.owner[0].label, pid: meta.owner[0].pid }))
          : null,
      );
    }

    function Timeline({ sessionId, feed, t, onRetry }) {
      const scrollRef = React.useRef(null);
      const [atBottom, setAtBottom] = React.useState(true);
      const lastSession = React.useRef(null);
      const turns = React.useMemo(() => groupItems(feed.items), [feed.items]);
      const meta = feed.meta;

      const scrollToEnd = React.useCallback((smooth) => {
        const node = scrollRef.current;
        if (node === null) return;
        node.scrollTo({ top: node.scrollHeight, behavior: smooth ? "smooth" : "auto" });
      }, []);

      React.useEffect(() => {
        if (sessionId !== lastSession.current) {
          lastSession.current = sessionId;
          setAtBottom(true);
          return;
        }
        if (atBottom) scrollToEnd(false);
      }, [feed.items.length, atBottom, scrollToEnd, sessionId]);

      const onScroll = () => {
        const node = scrollRef.current;
        if (node === null) return;
        const bottom = node.scrollHeight - node.scrollTop - node.clientHeight < 90;
        setAtBottom(bottom);
      };

      const hasReadError = typeof meta?.readError === "string" && meta.readError.length > 0;
      const showEmpty = turns.length === 0;
      const emptyError = feed.error ?? (hasReadError ? meta.readError : null);
      const emptyKind = meta === null
        ? (sessionId !== null && feed.error
          ? "error"
          : sessionId !== null && feed.loading
            ? "loading"
            : "choose")
        : !meta.hasLog
          ? "no-log"
          : emptyError && feed.items.length === 0
            ? "error"
            : "empty";

      return h("main", { className: "visor-main" },
        meta !== null
          ? h("header", { className: "visor-header" },
            h("div", { className: "visor-header-top" },
              h("div", { className: "visor-title-block" },
                h("h2", null, meta.title || shortId(meta.id)),
                h("div", { className: "visor-subline" },
                  h("span", null, meta.cwd),
                  h("span", { className: "visor-session-id", title: meta.id }, meta.id),
                ),
              ),
              h("div", { className: "visor-badges" },
                h(LiveBadge, { live: meta.live, t }),
                h(OwnerBadge, { meta, t }),
                meta.truncated ? h(Badge, { tone: "owner" }, t("status.truncated")) : null,
                meta.degraded ? h(Badge, { tone: "error" }, t("status.readError")) : null,
                feed.error ? h(Badge, { tone: "error" }, t("status.connecting")) : null,
              ),
            ),
            h("div", { className: "visor-subline" },
              h("span", null, t("meta.size") + ": " + formatBytes(meta.logSize)),
              h("span", null, t("meta.events", { count: meta.eventCount })),
              meta.lastEventTime !== null
                ? h("span", null, t("meta.lastEvent", { time: formatTime(meta.lastEventTime) }))
                : null,
              meta.partialLine && meta.live ? h("span", null, t("status.partial")) : null,
            ),
            hasReadError
              ? h("div", { className: "visor-notice is-error" }, `${t("status.readError")}: ${meta.readError}`)
              : null,
            meta.degraded && !hasReadError
              ? h("div", { className: "visor-notice is-warn" }, t("notice.degraded"))
              : null,
            feed.error
              ? h("div", { className: "visor-notice is-error" }, `${t("feed.error")} ${feed.error}`)
              : null,
          )
          : null,
        h("div", { className: "visor-timeline-wrap" },
          h("div", { className: "visor-timeline", ref: scrollRef, onScroll, role: "log", "aria-label": meta ? meta.title || meta.id : t("title") },
            h("div", { className: "visor-timeline-inner" },
              showEmpty
                ? h(EmptyPane, {
                  kind: emptyKind,
                  meta: emptyError && feed.items.length === 0 ? emptyError : meta,
                  t,
                  onRetry,
                })
                : turns.map((turn, index) => h(TurnBlock, {
                  key: `${turn.number}-${index}`,
                  turn,
                  isLast: index === turns.length - 1,
                  live: meta?.live === true,
                  t,
                })),
            ),
          ),
          !showEmpty && !atBottom
            ? h("button", { type: "button", className: "visor-button visor-jump", onClick: () => scrollToEnd(true) },
              t("action.jumpEnd"))
            : null,
        ),
      );
    }

    function VisorPage(props) {
      const t = props.t ?? ((key) => key);
      const [sessionsState, refreshSessions] = useSessions();
      const [selectedId, setSelectedId] = React.useState(() => {
        try {
          return window.sessionStorage.getItem(SELECTED_KEY);
        } catch {
          return null;
        }
      });
      const [query, setQuery] = React.useState("");
      const [feedReload, setFeedReload] = React.useState(0);
      const [acpOnly, setAcpOnly] = React.useState(true);

      const acpFiltered = React.useMemo(
        () => sessionsState.sessions.filter((session) => isExternalAcpOwner(session, sessionsState.hostPid)),
        [sessionsState.sessions, sessionsState.hostPid],
      );
      const eligible = acpOnly ? acpFiltered : sessionsState.sessions;

      React.useEffect(() => {
        if (sessionsState.status !== "ready") return;
        if (eligible.length === 0) {
          if (selectedId !== null) setSelectedId(null);
          return;
        }
        if (selectedId !== null && eligible.some((session) => session.id === selectedId)) return;
        let stored = null;
        try {
          stored = window.sessionStorage.getItem(SELECTED_KEY);
        } catch {
          // sessionStorage indisponível
        }
        const next = eligible.find((session) => session.id === stored) ?? eligible[0];
        setSelectedId(next.id);
      }, [eligible, sessionsState.status, selectedId]);

      React.useEffect(() => {
        if (selectedId === null) return;
        try {
          window.sessionStorage.setItem(SELECTED_KEY, selectedId);
        } catch {
          // sessionStorage indisponível
        }
      }, [selectedId]);

      const feed = useFeed(selectedId, feedReload);
      const filtered = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (needle.length === 0) return eligible;
        return eligible.filter((session) =>
          [session.id, session.cwd, session.dirName, session.title]
            .filter((value) => typeof value === "string")
            .some((value) => value.toLowerCase().includes(needle)),
        );
      }, [query, eligible]);
      const noAcpMatches = acpOnly && acpFiltered.length === 0 && sessionsState.sessions.length > 0;

      const retrySessions = React.useCallback(() => {
        refreshSessions(new AbortController().signal);
      }, [refreshSessions]);

      const retryFeed = React.useCallback(() => {
        setFeedReload((value) => value + 1);
      }, []);

      return h(React.Fragment, null,
        h("style", null, css),
        h("div", { className: "visor-root" },
          h("aside", { className: "visor-side", "aria-label": t("list.title") },
            h("div", { className: "visor-side-head" },
              h("h1", null, t("title")),
              h("p", null, t("subtitle")),
            ),
            h("div", { className: "visor-side-tools" },
              h("input", {
                className: "visor-search",
                type: "search",
                value: query,
                placeholder: t("list.search"),
                "aria-label": t("list.search"),
                onChange: (event) => setQuery(event.target.value),
              }),
              h("button", {
                type: "button",
                className: "visor-button",
                onClick: retrySessions,
                title: t("list.refresh"),
              }, t("list.refresh")),
            ),
            h("div", { className: "visor-filter-row" },
              h("label", null,
                h("input", {
                  type: "checkbox",
                  checked: acpOnly,
                  onChange: (event) => setAcpOnly(event.target.checked),
                }),
                h("span", null, t("filter.acpOnly")),
              ),
            ),
            h("div", { className: "visor-side-count" },
              sessionsState.status === "loading"
                ? t("list.loading")
                : t("list.count", { count: filtered.length }),
            ),
            h("div", { className: "visor-side-scroll" },
              sessionsState.status === "error" && sessionsState.sessions.length === 0
                ? h("div", { className: "visor-notice is-error" },
                  t("list.error"),
                  h("div", { className: "visor-mono", style: { fontSize: 10.5 } }, sessionsState.error ?? ""),
                  h("button", { type: "button", className: "visor-button", onClick: retrySessions }, t("action.retry")),
                )
                : null,
              filtered.length === 0 && sessionsState.status !== "loading"
                ? noAcpMatches
                  ? h("div", { className: "visor-empty", style: { padding: "28px 14px" } },
                    h("h3", null, t("filter.emptyAcp")),
                    h("p", null, t("filter.emptyAcpHint")),
                    h("button", {
                      type: "button",
                      className: "visor-button",
                      onClick: () => setAcpOnly(false),
                    }, t("filter.showAll")),
                  )
                  : h("div", { className: "visor-empty", style: { padding: "28px 14px" } },
                    h("h3", null, t("list.empty")),
                    h("p", null, t("list.emptyHint")),
                    sessionsState.root ? h("p", { className: "visor-mono" }, sessionsState.root) : null,
                  )
                : null,
              filtered.map((session) => h(SessionRow, {
                key: session.id,
                session,
                selected: session.id === selectedId,
                onSelect: (id) => {
                  setSelectedId(id);
                  setQuery("");
                },
                t,
              })),
            ),
          ),
          h(Timeline, { sessionId: selectedId, feed, t, onRetry: retryFeed }),
        ),
      );
    }

    class VisorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        try {
          console.error("visor-dsh: slot crashed", error, info);
        } catch {
          // console indisponível
        }
      }

      render() {
        const t = this.props.t ?? ((key) => key);
        if (this.state.error !== null) {
          return h("div", { className: "visor-root" },
            h("div", { className: "visor-empty" },
              h("h3", null, t("feed.error")),
              h("p", { className: "visor-mono" }, String(this.state.error?.message ?? this.state.error)),
            ),
          );
        }
        return this.props.children;
      }
    }

    function Page(props) {
      const t = props.t ?? ((key) => key);
      return h(VisorBoundary, { t }, h(VisorPage, props));
    }

    function VisorIcon({ size = 16 }) {
      return h("svg", {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.7,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": true,
        focusable: "false",
        style: { display: "block" },
      },
      h("path", { d: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" }),
      h("circle", { cx: 12, cy: 12, r: 2.7 }),
      h("path", { d: "M12 5.5V3.5M12 20.5v-2" }),
      );
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, "en", en), "visor-dsh: en dictionary");
        ctx.effect(() => ctx.locale.register(NS, "pt", pt), "visor-dsh: pt dictionary");

        ctx.slots.inject("main", () => ctx.slots.register({
          name: "main",
          key: PANEL_ID,
          locale: NS,
        }, Page));

        ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 30,
          locale: NS,
          label: () => t("panel.label"),
        }, VisorIcon));
      },
    };
  },
});
