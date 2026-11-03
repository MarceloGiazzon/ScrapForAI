import type { Frame, Page } from 'playwright';

/**
 * T4.3: the page described without what it holds. No field value, no typed text and no cell text is read here;
 * a label comes from `<label>`, aria attributes, placeholder or title, and a button's caption from its own text.
 * Used by `inspect_dom` (includeStructure) and by the `captureInventory` step (snapshots, T4.4).
 */
export interface DomStructure {
  fields: {
    id?: string;
    name?: string;
    tag: string;
    type: string;
    label?: string;
    required: boolean;
    enabled: boolean;
    visible: boolean;
    maxLength?: number;
    options?: string[];
  }[];
  actions: { id?: string; name?: string; tag: string; label?: string; enabled: boolean; visible: boolean }[];
  tables: { id?: string; name?: string; caption?: string; columns: string[] }[];
}

export async function extractStructure(target: Page | Frame, options: { includeHiddenControls: boolean }): Promise<DomStructure> {
  return target.evaluate((includeHiddenControls) => {
    const MAX_ITEMS = 500;
    const MAX_SELECT_OPTIONS = 100;

    function truncate(value: string | null | undefined, maxLength: number): string | undefined {
      if (!value) return undefined;
      return value.replace(/\s+/g, ' ').trim().slice(0, maxLength) || undefined;
    }

    function isVisible(element: Element): boolean {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    }

    function ownText(element: Element): string | undefined {
      const clone = element.cloneNode(true) as Element;
      clone.querySelectorAll('input, select, textarea, button, script, style').forEach((node) => node.remove());
      return truncate(clone.textContent, 200);
    }

    function fieldLabel(element: Element): string | undefined {
      const labels = (element as HTMLInputElement).labels;
      const fromLabels = labels ? Array.from(labels).map((label) => ownText(label)).filter(Boolean).join(' ') : '';
      const labelledBy = element
        .getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map((id) => {
          const target = document.getElementById(id);
          return target ? ownText(target) : undefined;
        })
        .filter(Boolean)
        .join(' ');
      return (
        truncate(fromLabels, 200) ||
        truncate(element.getAttribute('aria-label'), 200) ||
        truncate(labelledBy, 200) ||
        truncate(element.getAttribute('placeholder'), 200) ||
        truncate(element.getAttribute('title'), 200)
      );
    }

    const fieldSelector = [
      'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"])',
      'textarea',
      'select',
      '[role="textbox"]',
      '[role="combobox"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="switch"]',
      '[role="spinbutton"]',
      '[contenteditable="true"]',
    ].join(',');
    const actionSelector = [
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      'input[type="reset"]',
      'input[type="image"]',
      'a[href]',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="tab"]',
    ].join(',');

    const fields = Array.from(document.querySelectorAll(fieldSelector))
      .slice(0, MAX_ITEMS)
      .map((element) => {
        const htmlElement = element as HTMLInputElement;
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute('role');
        const maxLengthAttr = element.getAttribute('maxlength');
        const maxLength = maxLengthAttr !== null && /^\d+$/.test(maxLengthAttr) ? Number(maxLengthAttr) : undefined;
        let options: string[] | undefined;
        // A select with hundreds of options holds data (customers, products), not structure: leave them out.
        if (element instanceof HTMLSelectElement && element.options.length <= MAX_SELECT_OPTIONS) {
          options = Array.from(element.options)
            .map((option) => truncate(option.label || option.textContent, 200))
            .filter((label): label is string => Boolean(label));
        }
        return {
          id: htmlElement.id || undefined,
          name: element.getAttribute('name') || undefined,
          tag,
          type:
            tag === 'input'
              ? (element.getAttribute('type') || 'text').toLowerCase()
              : tag === 'textarea'
                ? 'textarea'
                : tag === 'select'
                  ? (element as HTMLSelectElement).multiple
                    ? 'select-multiple'
                    : 'select'
                  : role || 'contenteditable',
          label: fieldLabel(element),
          required: Boolean(htmlElement.required || element.getAttribute('aria-required') === 'true'),
          enabled: !(htmlElement.disabled || element.getAttribute('aria-disabled') === 'true'),
          visible: isVisible(element),
          maxLength,
          options,
        };
      })
      .filter((field) => includeHiddenControls || field.visible);

    const actions = Array.from(document.querySelectorAll(actionSelector))
      .slice(0, MAX_ITEMS)
      .map((element) => {
        const htmlElement = element as HTMLInputElement;
        const tag = element.tagName.toLowerCase();
        return {
          id: htmlElement.id || undefined,
          name: element.getAttribute('name') || undefined,
          tag,
          label:
            (tag === 'input' ? truncate(element.getAttribute('value'), 200) : truncate(element.textContent, 200)) ||
            truncate(element.getAttribute('aria-label'), 200) ||
            truncate(element.getAttribute('title'), 200) ||
            truncate(element.querySelector('img[alt]')?.getAttribute('alt'), 200) ||
            truncate(element.getAttribute('alt'), 200),
          enabled: !(htmlElement.disabled || element.getAttribute('aria-disabled') === 'true'),
          visible: isVisible(element),
        };
      })
      .filter((action) => includeHiddenControls || action.visible);

    const tables = Array.from(document.querySelectorAll('table, [role="grid"], [role="table"]'))
      .slice(0, MAX_ITEMS)
      .map((element) => ({
        id: (element as HTMLElement).id || undefined,
        name: element.getAttribute('name') || undefined,
        caption: truncate(element.querySelector('caption')?.textContent, 200) || truncate(element.getAttribute('aria-label'), 200),
        columns: Array.from(element.querySelectorAll('th, [role="columnheader"]'))
          .map((header) => ownText(header) ?? '')
          .slice(0, 200),
      }))
      // Layout tables (no header cells) are not grids.
      .filter((table) => table.columns.length > 0);

    return { fields, actions, tables };
  }, options.includeHiddenControls);
}
