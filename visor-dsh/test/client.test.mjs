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

  const plugin = moduleDefinition.factory((specifier) => {
    assert.equal(specifier, "react");
    return React;
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
