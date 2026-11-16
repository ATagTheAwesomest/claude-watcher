/**
 * A small stand-in for the parts of the Obsidian API the plugin touches, so
 * views and commands can run in a test DOM. It mimics behaviour only as far
 * as the tests need.
 */

type Attrs = { cls?: string; text?: string; attr?: Record<string, string>; value?: string };

function createEl(this: HTMLElement, tag: string, o: Attrs = {}): HTMLElement {
  const el = document.createElement(tag);
  if (o.cls) el.className = o.cls;
  if (o.text !== undefined) el.textContent = o.text;
  for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
  // An empty value is left unset, as Obsidian may do, so an option falls back to its text.
  if (o.value) (el as HTMLInputElement).value = o.value;
  this.appendChild(el);
  return el;
}

// Obsidian's DOM helpers; their types come from the obsidian package.
Object.assign(HTMLElement.prototype, {
  createEl,
  createDiv(this: HTMLElement, o?: Attrs) {
    return createEl.call(this, "div", o);
  },
  createSpan(this: HTMLElement, o?: Attrs) {
    return createEl.call(this, "span", o);
  },
  empty(this: HTMLElement) {
    this.replaceChildren();
  },
  setText(this: HTMLElement, text: string) {
    this.textContent = text;
  },
  addClass(this: HTMLElement, ...cls: string[]) {
    this.classList.add(...cls);
  },
  removeClass(this: HTMLElement, ...cls: string[]) {
    this.classList.remove(...cls);
  },
  toggleClass(this: HTMLElement, cls: string, on: boolean) {
    this.classList.toggle(cls, on);
  },
});

export const Platform = { isPhone: false, isMobile: false, isDesktop: true };

export class TFile {
  constructor(
    public path: string,
    public extension = "md",
  ) {}
  get basename(): string {
    return this.path.split("/").pop()!.replace(/\.md$/, "");
  }
}

export class Notice {
  static shown: string[] = [];
  noticeEl = document.createElement("div");
  constructor(message: string) {
    Notice.shown.push(message);
  }
}

export class Events {
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  on(name: string, fn: (...args: unknown[]) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]);
    return { name, fn };
  }
  trigger(name: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(name) ?? []) fn(...args);
  }
}

export function setIcon(el: HTMLElement, icon: string) {
  el.setAttribute("data-icon", icon);
}

export function debounce<T extends unknown[]>(fn: (...args: T) => void) {
  return (...args: T) => fn(...args);
}

export function requestUrl(): never {
  throw new Error("No network in tests");
}

export const editorInfoField = {};
export const MarkdownRenderer = {
  async render(_app: unknown, text: string, el: HTMLElement) {
    el.createEl("p", { text });
  },
};
export class MarkdownView {}

export class Component {
  register() {}
  registerEvent() {}
  registerInterval() {}
  registerDomEvent() {}
}

export class ItemView extends Component {
  containerEl = document.createElement("div");
  contentEl = this.containerEl.appendChild(document.createElement("div"));
  app: App;
  constructor(public leaf: WorkspaceLeaf) {
    super();
    this.app = leaf.app;
  }
  /** As in Obsidian: the leaf mounts a view by calling this, which then calls onOpen. */
  async open(parentEl: HTMLElement): Promise<void> {
    parentEl.appendChild(this.containerEl);
    await (this as { onOpen?(): Promise<void> }).onOpen?.();
  }
}

type View = { getViewType(): string; open(parentEl: HTMLElement): Promise<void> };

export class WorkspaceLeaf {
  view: View | undefined;
  containerEl = document.createElement("div");
  detached = false;
  constructor(
    public app: App,
    public root: unknown,
  ) {}
  getRoot() {
    return this.root;
  }
  async setViewState({ type }: { type: string }) {
    const view = this.app.viewFactories.get(type)!(this);
    this.view = view;
    this.containerEl.empty();
    await view.open(this.containerEl);
  }
  detach() {
    this.detached = true;
    this.app.workspace.leaves = this.app.workspace.leaves.filter((l) => l !== this);
  }
  async loadIfDeferred() {}
}

class Workspace extends Events {
  rootSplit = { name: "main" };
  rightSplit = { name: "right", collapsed: false };
  leftSplit = { name: "left", collapsed: false };
  leaves: WorkspaceLeaf[] = [];
  activeFile: TFile | null = null;
  constructor(private app: App) {
    super();
  }
  getActiveFile() {
    return this.activeFile;
  }
  getLeavesOfType(type: string) {
    return this.leaves.filter((leaf) => leaf.view?.getViewType() === type);
  }
  private add(root: unknown) {
    const leaf = new WorkspaceLeaf(this.app, root);
    this.leaves.push(leaf);
    return leaf;
  }
  getRightLeaf() {
    return this.add(this.rightSplit);
  }
  getLeaf() {
    return this.add(this.rootSplit);
  }
  async revealLeaf() {}
  iterateAllLeaves(fn: (leaf: WorkspaceLeaf) => void) {
    this.leaves.forEach(fn);
  }
  onLayoutReady() {}
  updateOptions() {}
}

export class App {
  viewFactories = new Map<string, (leaf: WorkspaceLeaf) => View>();
  workspace: Workspace = new Workspace(this);
  vault = {
    files: [] as TFile[],
    on() {
      return {};
    },
    getMarkdownFiles() {
      return this.files;
    },
    getAbstractFileByPath(path: string) {
      return this.files.find((file) => file.path === path) ?? null;
    },
  };
  metadataCache = {
    getFirstLinkpathDest: (link: string) =>
      this.vault.files.find((f) => f.path === link || f.basename === link) ?? null,
  };
}

export class Plugin extends Component {
  ribbon: { icon: string; title: string; onClick: () => void }[] = [];
  commands: {
    id: string;
    name: string;
    icon?: string;
    callback?: () => void;
    checkCallback?: (checking: boolean) => boolean;
  }[] = [];
  constructor(public app: App) {
    super();
  }
  async loadData() {
    return {};
  }
  async saveData() {}
  addSettingTab() {}
  registerView(type: string, factory: (leaf: WorkspaceLeaf) => View) {
    this.app.viewFactories.set(type, factory);
  }
  registerEditorExtension() {}
  addRibbonIcon(icon: string, title: string, onClick: () => void) {
    this.ribbon.push({ icon, title, onClick });
  }
  addCommand(command: Plugin["commands"][number]) {
    this.commands.push(command);
  }
}

export class Modal {
  constructor(public app: App) {}
  open() {}
  close() {}
}
export class FuzzySuggestModal<T> extends Modal {
  setPlaceholder() {}
  declare items?: T[];
}
export class PluginSettingTab {
  constructor(public app: App) {}
}
export class Setting {}
