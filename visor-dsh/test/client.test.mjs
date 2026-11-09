/**
 * Verifica o contrato do módulo Client: formato do module loader, registros de
 * slot e dicionários. Não renderiza React (sem browser control nesta sessão).
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("client.js registra main e sidebar.panellist no locale visor-dsh", async () => {
  const code = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");
  // Regressão do layout mobile: o header não pode espremer o título ao lado
  // dos badges em 390px; a lista vira uma faixa e o título ocupa a linha toda.
  assert.match(code, /\.visor-header-top\s*\{\s*flex-direction:\s*column/u);
  assert.match(code, /\.visor-title-block\s*\{\s*flex:\s*0 0 auto;\s*width:\s*100%/u);
  assert.match(code, /max-height:\s*min\(34%,\s*260px\)/u);
  assert.match(code, /\.visor-subline > span\s*\{\s*min-width:\s*0;\s*overflow-wrap:\s*anywhere/u);
  assert.match(code, /\.visor-root:not\(\.is-side-open\) \.visor-side\s*\{\s*display:\s*none/u);
  assert.match(code, /\.visor-side-toggle\s*\{\s*display:\s*inline-flex/u);
  assert.match(code, /"status\.idle": "Idle"/u);
  assert.match(code, /"status\.idle": "Ocioso"/u);
  assert.match(code, /"turn\.openStopped": "aberto \/ sem atividade"/u);
  assert.match(code, /function LiveBadge\(\{ meta, t \}\)/u);
  assert.match(code, /require\("@deepseek-ai\/dsh-client-ui-primitives"\)/u);
  assert.match(code, /h\(MarkdownText, \{ text, labels \}\)/u);
  assert.match(code, /"markdown\.copy": "Copiar"/u);
  assert.match(code, /useClipboardCopy\(item\.text\)/u);
  assert.match(code, /className: "visor-copy-button"/u);
  let moduleDefinition;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          moduleDefinition = definition;
        },
      },
    },
    console,
  };
  vm.runInNewContext(code, sandbox, { filename: "client.js" });
  assert.ok(moduleDefinition, "client.js chamou window.__ModuleLoader__.load");
  assert.equal(moduleDefinition.id, "@local/dsh-visor");

  class Component {}
  const React = {
    Component,
    Fragment: Symbol("Fragment"),
    createElement: (...args) => ({ args }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: () => [null, () => {}],
  };

  const fakeMarkdownText = () => null;
  const plugin = moduleDefinition.factory((specifier) => {
    if (specifier === "react") return React;
    if (specifier === "@deepseek-ai/dsh-client-ui-primitives") {
      return {
        MarkdownText: fakeMarkdownText,
        useClipboardCopy: () => ({ copied: false, onCopy: () => {} }),
        IconCopyOutlineRegular: () => null,
        IconCheckOutlineRegular: () => null,
      };
    }
    throw new Error(`unexpected require: ${specifier}`);
  });
  assert.deepEqual([...plugin.inject], ["slots", "locale"]);

  const registrations = [];
  const dictionaries = [];
  const ctx = {
    effect: (factory) => {
      factory();
    },
    locale: {
      register: (ns, locale, dict) => {
        dictionaries.push({ ns, locale, keys: Object.keys(dict).length });
        return () => {};
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (_owner, callback) => {
        callback();
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  plugin.apply(ctx);

  assert.equal(dictionaries.length, 2);
  assert.ok(dictionaries.every((item) => item.ns === "visor-dsh"));
  assert.ok(dictionaries.some((item) => item.locale === "en" && item.keys > 20));
  assert.ok(dictionaries.some((item) => item.locale === "pt" && item.keys > 20));

  const main = registrations.find((item) => item.options.name === "main");
  assert.ok(main, "slot main registrado");
  assert.equal(main.options.key, "visor-dsh");
  assert.equal(main.options.locale, "visor-dsh");
  assert.equal(typeof main.component, "function");

  const side = registrations.find((item) => item.options.name === "sidebar.panellist");
  assert.ok(side, "slot sidebar.panellist registrado");
  assert.equal(side.options.id, "visor-dsh");
  assert.equal(side.options.order, 30);
  assert.equal(typeof side.options.label, "function");
  assert.equal(side.options.label(), "panel.label");
  assert.equal(typeof side.component, "function");
});
