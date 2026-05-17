# Pi Symbol Autocomplete

Pi extension that adds `#` symbol autocomplete in the session editor and injects referenced symbol definitions into the model context for the current turn.

## Install

From GitHub:

```bash
pi install git:github.com/Mathuv/pi-symbol-autocomplete
```

For local development from this checkout:

```bash
pi install /local/path/to/pi-symbol-autocomplete
```

Then run `/reload` in Pi.

## Usage

Type `#` at the start of a prompt token or after whitespace, then start typing a symbol name. The extension fuzzy-matches definition-level symbols from the current repository, including classes, functions, methods, interfaces, types, enums, and module-level variables/constants.

Selecting a suggestion inserts a stable token:

```text
#<name>@<repo-relative-path>:<line>
```

Example:

```text
Explain #createSymbolIndexManager@extensions/symbol-autocomplete/symbol-index.ts:216
```

On submit, Pi injects a hidden `symbol-context` message containing the resolved symbol metadata, definition snippet, and bounded surrounding context. The user-authored prompt text is not rewritten.

## Reference modes

- **Selected stable token** — `#<name>@<repo-relative-path>:<line>` resolves by exact name/path/line. If the line is stale, it falls back to same-name in the same file and warns once in the UI. It never falls back across files.
- **Plain typed reference** — `#name` resolves only when exactly one indexed symbol has that name. Ambiguous or missing plain references are skipped with a UI warning.

References inside triple-backtick fenced code blocks are ignored.

## Indexing

The index is in memory only. It is rebuilt on session start and via `/rescan-symbols`; it is not stored in a database or session file.

Index source order:

1. Existing `tags` file in the current working directory, when present.
2. Fresh `ctags --recurse --fields=+K+n --output-format=json .` scan.
3. `ast-grep` fallback when ctags fails or times out.

Indexing is asynchronous and non-blocking. If a prompt is submitted while the index is still building, the turn proceeds without symbol injection and Pi shows a UI-only warning.

Default excludes skip heavy/vendor/generated directories such as `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, `vendor`, caches, and similar paths.

## Limits

- Max 8 symbol payloads per prompt.
- About 3000 chars per symbol payload.
- Truncated payloads include `...[truncated]`.
- Warnings are shown via Pi UI notifications only; warnings are not injected into the prompt.

## Commands

| Command | Description |
| --- | --- |
| `/rescan-symbols` | Rebuild the symbol index asynchronously; concurrent scans coalesce. |
| `/symbol-autocomplete-status` | Show index engine, symbol count, last refresh time, in-flight state, and last error. |

## Development

Run tests:

```bash
npm test
```

The tests use Node's built-in test runner with TypeScript type stripping.

## Requirements

- Pi coding agent - [https://pi.dev/](https://pi.dev/)
- Universal Ctags recommended (`ctags` on PATH) - [https://github.com/universal-ctags/ctags](https://github.com/universal-ctags/ctags)

    ```bash
    brew install universal-ctags

    ```
- ast-grep optional fallback (`ast-grep` on PATH) - [https://github.com/ast-grep/ast-grep](https://github.com/ast-grep/ast-grep)

    ```bash
    brew install ast-grep
    npm install --g @ast-grep/cli
    ```
