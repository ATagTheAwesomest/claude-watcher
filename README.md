# Claude Watcher

An Obsidian plugin that lets Claude work on your notes while you decide what it
may see and which of its edits reach your vault.

It is the front end of the
[Claude Watcher Server](https://github.com/ATagTheAwesomest/claude-watcher-server),
which watches the vault, keeps a mirror folder with only the notes Claude may
read, and runs Claude Code on that mirror. The plugin talks to the server over
its HTTP API. It works on desktop and mobile.

## Status

Early development. Approval cards, the chat sidebar and inline review of
Claude's edits are in place.

## What it does

### Approval cards

When Claude asks to see more of a private note, the server suggests a few
ranges, best match first. Each suggestion appears as a card in the
**Claude approvals** panel:

- The card names the note and the range. The server never sends note text:
  the plugin reads it from this vault and highlights the range in green.
- Drag either green edge to widen or narrow the selection, or select text in
  the card and press **Use my selection**. Untick **Whole lines** to select
  exact characters.
- **Approve** releases the selected text into Claude's mirror. Claude is not
  told whether you changed the selection.
- **Reject** declines one suggestion; **Reject all** declines every suggestion
  for that request.

With every approval the plugin sends a SHA-256 hash of the text it showed you.
If the server's copy of the note differs, for example because sync has not
caught up, the approval is refused and nothing is released.

### Chat sidebar

The **Claude chat** panel works like a chat panel in a code editor.

- In a note whose title ends with `%%`, run **Send this note's instructions to
  Claude**. The note's `[c: ...]` instructions become your first message. They
  stay in the note; the chat shows them with links back to their lines.
- Claude's reply appears below, followed by the edits it proposes. Click an
  edit to jump to it in the note.
- Keep writing to refine the result. Follow-up messages continue the same
  Claude session, so notes Claude has already read are not sent again.
- Choose **Simple task** or **Complex task** per message. The server runs
  simple tasks on a smaller model.

### Edits in the note

Claude's edits are shown in the note itself: lines it replaces are marked red,
and the new lines appear in green below them with **Accept** and **Reject**
buttons.

- Edits close together form one change; edits far apart, such as the top and
  bottom of a note, are separate changes.
- **Accept** writes the change into the note. This is the only way an edit of
  Claude's reaches the vault. It is applied only if the note still matches the
  text Claude edited.
- **Reject** takes the edit back out of Claude's mirror copy.

## Installing

The plugin is not in the community plugin list yet. To install it by hand:

```sh
npm install
npm run build
```

Copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/claude-watcher/`, then enable **Claude Watcher** under
**Settings → Community plugins**. On mobile, copy the same three files into
that folder through your sync.

## Settings

| Setting           | Meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| Server address    | Where the server is reachable, such as `https://watcher.example.com` |
| API key           | The server's `WATCHER_API_KEY`                                       |
| Check every       | Seconds between checks for new requests and edits                    |
| Default task size | Task size a new message starts with                                  |

The tab also shows the server's search mode and the most suggestions it offers
per request. Those are set on the server.

The API key is stored in the plugin's `data.json` inside the vault's
`.obsidian` folder. Use a long random key and reach the server over HTTPS, for
example through a Cloudflare Tunnel.

## Commands

| Command                                 | What it does                               |
| --------------------------------------- | ------------------------------------------ |
| Open approvals                          | Opens the approval panel                   |
| Open chat                               | Opens the chat panel                       |
| Send this note's instructions to Claude | Starts a chat from the current `%%` note   |
| Check for requests now                  | Asks the server for new requests and edits |

## Development

Requires Node.js 22 or newer.

```sh
npm install
npm run dev          # rebuild main.js on every change
npm test             # unit tests
npm run lint
npm run build        # type check and production build
```

For a quick loop, link this folder into a test vault's
`.obsidian/plugins/claude-watcher` folder and reload the plugin after each
build.

### Shared types

`src/shared/types.ts` describes the server's API. It is a copy of the same
file in the server repository and must not be edited here. After the server's
types change, copy them over:

```sh
npm run sync-types -- ../claude-watcher-server
```

### Project layout

```text
src/
├── main.ts            plugin entry: views, commands, polling
├── settings.ts        settings tab
├── api.ts             HTTP client for the server
├── approvalsView.ts   approval cards
├── rangePicker.ts     text with a draggable green selection
├── suggestions.ts     grouping and ranking of suggestions
├── chatView.ts        chat sidebar
├── edits.ts           pending edits in the editor, accept and reject
├── text.ts            ranges, hashes and applying changes
└── shared/types.ts    API types copied from the server
```
