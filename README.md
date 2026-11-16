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

### Start a chat

A chat needs no note and no instructions. Open a new one from anywhere:

- the **New Claude chat** ribbon icon (in the menu on a phone),
- the command **New chat**, or **New chat about this note** to start with a link
  to the open note,
- **New Claude chat about this note** in a note's menu (the **...** menu on a
  phone, right click on a desktop),
- the **New chat** button at the top of the chat panel.

The chat opens with the message box ready. On a phone it opens in the right drawer.
To reach it in one tap on iOS or Android, add **New chat** to the mobile
toolbar under **Settings → Mobile**.

### Chat sidebar

The **Claude chat** panel works like a chat panel in a code editor.

- Type a message at the bottom to start a chat at any time. Use **New chat** for
  a new one and the list at the top to go back to an earlier one.
- Link notes in a message by typing `[[`, with the link button, or with the
  button that links the current note. Only the note's path is sent. Claude sees
  a linked note only if its title is marked `%` or `%%`, or when it asks for
  more and you approve an excerpt on an approval card.
- Links to notes in Claude's replies open the note when tapped.

### Adding notes and selections to a message

Like the chat in a code editor, a message can carry notes and lines of notes
as context. They show as chips above the message box; tap a chip to jump to
its lines and its **x** to take it off.

- **The open note.** When the note you are viewing is shared with Claude, by
  `%` or `%%` on its title or on a folder above it, it is attached on its own.
  Select some of it and the chip narrows to those lines. Remove it with its
  **x**; it stays off until you open another note. Private notes are never
  attached on their own. Turn this off with **Include the open note** in the
  settings.
- **A selection.** Select text in a note and a small **Lines 12-18 +** button
  appears under it. Click or tap it to add those lines. The same is in the
  note's menu (right click, or the editor menu on a phone) as **Add lines ...
  to Claude chat**, and as the command **Add selection to chat**, which can go
  in the mobile toolbar. Without a selection the command adds the whole note.
  On a desktop the chat opens beside the note; on a phone the note stays in
  view so you can add more before switching to the chat. Hide the button with
  **Selection button** in the settings.

Only paths and line numbers go to the server. A selection from a private note
first becomes an approval card, the same as when Claude asks for more, where
you can trim it before approving. A message that carries one waits until the
card is settled: once approved, it goes with the excerpt; if rejected, it goes
without it. Removing the chip withdraws the request.

This needs a watcher server that accepts message context. An older server
ignores the chips and cannot take private selections; the plugin says so.

### Asking Claude about an excerpt

Select text in a note and choose **Ask Claude about this excerpt** from the
note's menu (right click, or the editor menu on a phone), or run the command of
the same name, which can go in the mobile toolbar. The chat opens with the
excerpt attached as a chip; type a question, or send as is to have Claude
explain it. On a desktop the message box is ready to type in.

In a private note, choosing this is your approval of exactly the selected text,
so no approval card is shown. The plugin saves the note, sends the server the
selection's character range and the note's hash, and the server writes just
that text into the note's `[PN]` file. If the server's copy of the note has
not caught up with sync yet, the plugin waits a few seconds and tries again.

The excerpt is shared for that chat only:

- Remove its chip, before sending or later from the sent message, and its text
  leaves the mirror. The sent chip then shows it as ended.
- It expires on its own when the chat has gone unused for a day.
- Another chat is not told about it.

In a shared note the selection is simply attached by its lines, since Claude
can read the note already. This needs a watcher server with excerpt support;
an older one is reported in a notice.

- In a note whose title ends with `%%`, write instructions as `<c: ...>`, such
  as `<c: summarise this into three bullet points>`. They may span several
  lines. The older `[c: ...]` form still works. Instructions are tinted in the
  editor so you can see what will be sent.
- Run **Send this note's instructions to Claude**. The note's instructions
  become your first message. They stay in the note; the chat shows them with
  links back to their lines.
- Claude's reply appears below, followed by the edits it proposes. Click an
  edit to jump to it in the note.
- Keep writing to refine the result. Follow-up messages continue the same
  Claude session, so notes Claude has already read are not sent again.
- Pick the **model** and the **thinking effort** under the message box. The
  list comes from the server (`WATCHER_CLAUDE_MODELS`), so it only offers
  models your Claude plan can run. Higher effort means Claude thinks longer
  and uses more of the plan's usage. Each chat remembers what it last ran
  with. With a server too old to list its models, the box offers
  **Simple task** or **Complex task** instead.

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

The plugin is not in the community plugin list yet. Install it with BRAT or
by hand. You also need a running
[Claude Watcher Server](https://github.com/ATagTheAwesomest/claude-watcher-server)
and its API key.

### With BRAT

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs plugins from a
GitHub repository and keeps them up to date.

1. In Obsidian, open **Settings → Community plugins**, turn off Restricted
   mode if it is on, then **Browse**, find **BRAT**, install and enable it.
2. Open **Settings → BRAT** and choose **Add beta plugin**.
3. Paste `https://github.com/ATagTheAwesomest/claude-watcher` and choose
   **Add plugin**. Pick the latest version if asked.
4. Under **Settings → Community plugins**, make sure **Claude Watcher** is
   enabled.

This works on desktop and mobile.

### By hand

1. Open the [latest release](https://github.com/ATagTheAwesomest/claude-watcher/releases/latest)
   and download `manifest.json`, `main.js` and `styles.css`.
2. In your vault, create the folder `.obsidian/plugins/claude-watcher/` and put
   the three files in it. The `.obsidian` folder is hidden on most systems;
   in Obsidian, **Settings → Community plugins → Installed plugins** has a
   folder button that opens `.obsidian/plugins`.
3. Restart Obsidian, or press the reload button next to **Installed plugins**,
   then enable **Claude Watcher**.

On mobile, put the files in a desktop vault and let Obsidian Sync carry them
over, with **Installed community plugins** turned on in the Sync settings.

### Connect to the server

Open **Settings → Claude Watcher** and fill in:

- **Server address**: where the server is reachable, such as
  `https://watcher.example.com`.
- **API key**: the server's `WATCHER_API_KEY`.

Press **Test the connection** to check both. The **Claude approvals** and **Claude chat** panels then show requests from
the server. Use the commands **Open approvals** and **Open chat** if they are
not open.

### Building from source

```sh
npm install
npm run build
```

This writes `main.js` next to `manifest.json` and `styles.css`; copy the three
files as above.

### Releasing

Bump the version in `manifest.json` and `package.json`, add it to
`versions.json`, then push a tag with the same version, such as `0.1.1`. The
Release workflow builds the plugin and attaches the three files to a GitHub
release. It can also be started from the Actions tab, which tags the current
commit with the version in `manifest.json`.

## Settings

| Setting                 | Meaning                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| Server address          | Where the server is reachable, such as `https://watcher.example.com` |
| API key                 | The server's `WATCHER_API_KEY`                                       |
| Check every             | Seconds between checks for new requests and edits                    |
| Default model           | Model a new chat starts with, or the server's default                |
| Default thinking effort | Effort a new chat starts with, or the server's default               |
| Instruction syntax      | `<c: ...>` (default, also accepts `[c: ...]`) or `[c: ...]` only     |

When the server reports its own instruction syntax (`WATCHER_INSTRUCTION_SYNTAX`),
the plugin follows it and the setting shows that it is following the server.
The model and effort lists are read from the server. The tab also shows the server's search mode and the most suggestions it offers
per request. Those are set on the server.

The API key is stored in the plugin's `data.json` inside the vault's
`.obsidian` folder. Use a long random key and reach the server over HTTPS, for
example through a Cloudflare Tunnel.

## Commands

| Command                                 | What it does                               |
| --------------------------------------- | ------------------------------------------ |
| Open approvals                          | Opens the approval panel                   |
| New chat                                | Opens an empty chat                        |
| New chat about this note                | Opens an empty chat that links the note    |
| Open chat                               | Opens the chat panel on the latest chat    |
| Send this note's instructions to Claude | Starts a chat from the current `%%` note   |
| Add selection to chat                   | Attaches the selected lines, or the note   |
| Ask Claude about this excerpt           | Shares the selection with the chat at once |
| Check for requests now                  | Asks the server for new requests and edits |

## Development

Requires Node.js 22 or newer.

```sh
npm install
npm run dev          # rebuild main.js on every change
npm test             # unit and view tests
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
├── chatContext.ts     notes and selections attached to a message
├── contextBar.ts      context chips and approval of private selections
├── selectionButton.ts the "Lines 12-18 +" button under a selection
├── access.ts          which notes Claude can already read
├── noteLinks.ts       linking notes in chat messages
├── edits.ts           pending edits in the editor, accept and reject
├── instructions.ts    finding <c: ...> instructions in a note
├── instructionHighlight.ts  tinting instructions in the editor
├── text.ts            ranges, hashes and applying changes
└── shared/types.ts    API types copied from the server
tests/
└── support/obsidian.ts  stand-in for the Obsidian API used by view tests
```
