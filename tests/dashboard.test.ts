import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DASHBOARD_HTML, DASHBOARD_JS } from '../src/api/dashboard';

describe('Portuguese dashboard safety', () => {
  it('serves accessible responsive tabs and independent operation controls', () => {
    expect(DASHBOARD_HTML).toContain('lang="pt-BR"');
    for (const tab of ['sniper', 'copy', 'wallet', 'settings']) {
      expect(DASHBOARD_HTML).toContain(`id="tab-${tab}"`);
      expect(DASHBOARD_HTML).toContain(`id="panel-${tab}"`);
    }
    expect(DASHBOARD_HTML).toContain('@media(max-width:600px)');
    expect(DASHBOARD_HTML).toContain('Pausar não vende posições');
    expect(DASHBOARD_HTML).toContain('JSON exportado contém a chave privada');
    expect(DASHBOARD_HTML).toContain('fração de venda (0–1)');
  });

  it('keeps secrets in memory and uses text-only rendering', () => {
    expect(() => new vm.Script(DASHBOARD_JS)).not.toThrow();
    expect(DASHBOARD_JS).not.toMatch(/localStorage|sessionStorage|innerHTML|console\./);
    expect(DASHBOARD_JS).toContain("let apiKey = ''");
    expect(DASHBOARD_JS).toContain('textContent');
    expect(DASHBOARD_JS).toContain("wallet-standard:app-ready");
    expect(DASHBOARD_JS).toContain('confirmed: true');
  });

  it('tab selection only affects DOM state, never server operation state', () => {
    const selectTab = DASHBOARD_JS.slice(DASHBOARD_JS.indexOf('function selectTab'), DASHBOARD_JS.indexOf("document.querySelectorAll('[data-tab]').forEach((button"));
    expect(selectTab).toContain('aria-selected');
    expect(selectTab).not.toMatch(/api\(|fetch\(|operation\(/);
  });
});
