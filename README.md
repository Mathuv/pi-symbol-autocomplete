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

Type `#` at the start of a prompt token or after whitespace, then type at least one character of a symbol name. The extension matches symbol names by case-insensitive prefix against the repository `tags` file. It covers classes, functions, methods, interfaces, types, enums, and module-level variables and constants.

Matching is prefix-only. `#crea` finds `createUser` but not `recreate`. There is no fuzzy subsequence matching. A bare `#` delegates to the built-in provider.

The result list is capped at 50 items. The native TUI scrolls the list; the extension adds no custom pages.

Dotted member references autocomplete members scoped under a parent symbol. Type `#Campaign.reservatio` to find members indexed under `Campaign`:

```text
#Campaign.reservation_date@src/models/campaign.ts:42
```

A dotted query needs at least one character after the dot. `#Campaign.` shows nothing. The parent name matches case-insensitively by prefix, so `#camp.res` finds `Campaign.reservation_date`. v1 supports exactly one parent plus one member. Multi-hop chains such as `Namespace.Campaign.member` are not supported.

Selecting a suggestion inserts a stable token:

```text
#<name>@<repo-relative-path>:<line>
```

Example:

```text
Explain #createReadtagsBackend@extensions/symbol-autocomplete/readtags-backend.ts:353
```

On submit, Pi injects a hidden `symbol-context` message containing the resolved symbol metadata, definition snippet, and bounded surrounding context. The user-authored prompt text is not rewritten.

## Reference modes

- **Selected stable token** — `#<name>@<repo-relative-path>:<line>` resolves by exact name/path/line. If the line is stale, it falls back to same-name in the same file and warns once in the UI. It never falls back across files.
- **Selected dotted stable token** — `#<parent>.<member>@<repo-relative-path>:<line>` resolves by exact parent, member, path, and line. Stale fallback stays within the same file and parent/member combination.
- **Plain typed reference** — `#name` resolves only when exactly one indexed symbol has that name. Ambiguous or missing plain references are skipped with a UI warning.
- **Typed plain dotted reference** — `#<parent>.<member>` resolves only when exactly one indexed symbol has that parent name and member name combination. Ambiguous or missing dotted plain references are skipped with a UI warning.

References inside triple-backtick fenced code blocks are ignored.

## Indexing

Symbols are indexed with Universal Ctags into a `tags` file at the repository root (`<repo>/tags`). The tags stay on disk. The extension does not load them into memory.

At session start, the extension uses an existing `tags` file as-is. When the file is missing, the extension generates it with:

```text
ctags --recurse --sort=foldcase --fields=+KznZe <default excludes> -f <temporary file> .
```

ctags writes to a unique temporary file in the same directory as `tags`. When the build completes, the extension atomically renames the temporary file to `tags`. A failed, timed-out, or interrupted build removes the temporary file and never touches an existing `tags` file. A failed initial build leaves no `tags` file and disables symbol autocomplete with the error message.

The default excludes skip heavy, vendor, and generated directories such as `.git`, `node_modules`, `dist`, `build`, `.next`, `coverage`, `vendor`, caches, and similar paths.

`/rescan-symbols` always regenerates the `tags` file with the same command and replaces the existing file only when the new build completes.

The extension requires the Universal Ctags tools `ctags` and `readtags` on `PATH`. When `readtags` is missing or the tags file cannot be read, symbol autocomplete disables with a one-time warning. There is no in-memory fallback index.

Add `tags` to your `.gitignore` so the generated file is not committed. The extension does not edit your `.gitignore` automatically.

## Memory

The tags file stays on disk. Each query runs a `readtags` subprocess whose output is streamed line by line; the output is never buffered whole. Every query enforces hard bounds: a result cap, a scanned-line cap, a byte cap per line, a time cap, and an abort signal. The resolver keeps at most two candidate symbols per reference. Memory use stays bounded. The extension does not promise a specific byte count.

## Limits

- Max 50 autocomplete results.
- Max 8 symbol payloads per prompt.
- At most 8 distinct symbol names are looked up per prompt; later distinct names resolve as omitted with a warning. All lookups share one 5-second total deadline.
- About 3000 chars per symbol payload.
- Truncated payloads include `...[truncated]`.
- Warnings are shown via Pi UI notifications only; warnings are not injected into the prompt.
- v1 dotted member references are limited to lexical ctags scope (`Parent.member`). There is no runtime type inference and no arbitrary multi-hop chain resolution.

## Commands

| Command | Description |
| --- | --- |
| `/rescan-symbols` | Regenerate the repository `tags` file asynchronously. Concurrent rescans coalesce into one run. |
| `/symbol-autocomplete-status` | Show engine, tags path, file size, last modified time, in-flight build state, and last error. The report does not include a symbol count. |

## Development

Run tests:

```bash
npm test
```

The tests use Node's built-in test runner with TypeScript type stripping. The integration suite runs the real `ctags` and `readtags` binaries. It skips only when either binary is missing on `PATH`.

## Requirements

- Pi coding agent - [https://pi.dev/](https://pi.dev/)
- Universal Ctags (`ctags` and `readtags` on `PATH`) - [https://github.com/universal-ctags/ctags](https://github.com/universal-ctags/ctags)

    ```bash
    brew install universal-ctags
    ```
