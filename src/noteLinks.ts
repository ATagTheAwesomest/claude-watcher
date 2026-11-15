/**
 * Note links in chat messages. Only a note's path goes to the server: a
 * linked note stays private unless its title is marked or the owner approves
 * an excerpt when Claude asks for it.
 */

import { App, FuzzySuggestModal, TFile } from "obsidian";

/** Prefix the server gives partial excerpt files in the mirror. */
const PARTIAL_PREFIX = "[PN] ";

/** Lets the owner pick a note from the vault. */
export class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly onPick: (file: TFile) => void,
  ) {
    super(app);
    this.setPlaceholder("Link a note");
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onPick(file);
  }
}

/** The link written into a message for a note: its full vault path. */
export function linkFor(file: TFile): string {
  return `[[${file.path}]]`;
}

/**
 * Rewrites each [[link]] in a message to the full path of the note it points
 * to, so Claude knows exactly which note is meant. Unresolved links stay as
 * they are.
 */
export function resolveLinks(app: App, message: string, sourcePath = ""): string {
  return message.replace(/\[\[([^\]|#]+)([^\]]*)\]\]/g, (link, target: string, rest: string) => {
    const file = app.metadataCache.getFirstLinkpathDest(target.trim(), sourcePath);
    return file ? `[[${file.path}${rest}]]` : link;
  });
}

/** The vault note a link in Claude's reply points to, allowing for mirror excerpt names. */
export function linkTarget(app: App, href: string, sourcePath = ""): TFile | null {
  const path = href.split("#")[0]!.trim();
  const direct = app.metadataCache.getFirstLinkpathDest(path, sourcePath);
  if (direct) return direct;
  const slash = path.lastIndexOf("/") + 1;
  if (!path.startsWith(PARTIAL_PREFIX, slash)) return null;
  const vaultPath = path.slice(0, slash) + path.slice(slash + PARTIAL_PREFIX.length);
  return app.metadataCache.getFirstLinkpathDest(vaultPath, sourcePath);
}
