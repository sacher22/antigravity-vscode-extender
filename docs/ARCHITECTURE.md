# Antigravity Extender architecture

## Boundaries

- `adapters/workspaceAdapter.ts`: VS Code configuration, workspace and editor folder selection, diagnostics and terminal creation. Single-folder sessions use that folder. Multi-root sessions fix the primary folder at creation and pass all opened roots to CLI. No folder picker or project binding UI.
- `core/agyProcessManager.ts`: validated CLI v1.2.14 NDJSON, startup cancellation, process generations, and POSIX process-group cleanup. Uses the user's `agy` launcher without reading API credentials. Both modes explicitly pass `--mode`; model suffix expresses effort for supported Gemini families.
- `conversation/controller.ts`: authoritative conversation, turn and configuration state. Serialized mutations, independent stop cancellation, generation and CLI conversation fences, 30 ms text batches and recoverable snapshots. No VS Code import. Local IDs remain immutable; `cliConversationId` is separate.
- `conversation/repository.ts`: per-session metadata and ordered message/event files; latest 30 messages on first read; older pages read on demand. Tool output is stored separately and read in UTF-8-safe 64 KiB pages. Unchanged output is not serialized at every checkpoint. Workspace-scoped VS Code state stores the selected session. Records retain workspace metadata for execution compatibility checks.
- `ui/webviewBridge.ts`: runtime request validation, request IDs, deduplication, explicit completion/failure, and stale-session rejection. Provider implements editor actions and constructs a CSP-protected Webview.
- `webview/`: React + TypeScript, bundled by esbuild. Receives a snapshot then deltas, requests a snapshot on sequence gaps. Owns composer, scrolling and expanded details; derives mode and busy state from the controller. Stable message/block IDs and memoized components; plain streamed text uses incremental Text node appends, Markdown is parsed after completion and sanitized with DOMPurify.

## Lifecycle

`idle → connecting → submitted → responding/tool/waiting → completed/failed/permission_denied`

Stop goes through `stopping → aborted`. Stop cancels process initialization outside the operation queue, fences callbacks before killing the owned process group, and saves any existing output. New conversation creates an independent local ID and controller while the old turn continues; repeated clicks are coalesced. A blank conversation is reused and focused. New conversations inherit model/effort/permission and use normal mode. Drafts and attachments belong to their own session. CLI handoff releases the process, holds an execution lease until its terminal closes, and opens a fresh sidebar conversation.

A CLI conversation lease and temporary writer leases prevent other extension windows from concurrently running or writing the same CLI history. Locks contain PID and a random ownership token; stale PIDs can be recovered. There is no shared mutable history index. Atomic writes use unique temporary files. Locks do not govern externally launched CLI processes; the extension only controls its own processes and handoff terminals.

## Migration and rollback

Storage: VS Code globalStorage `conversations-v3/<sha256(localId)>/` with `session.json`, `messages/`, `tools/`, `events.ndjson`; all files are private to the user. Workspace grouping is represented by session metadata, with workspace-scoped selection. This avoids moving a session's files when legacy workspace metadata is first verified.

Migration backs up legacy `sessions-v2` plus the legacy globalState array, validates individual records, isolates corrupt records with diagnostic pointers, then writes a completion marker. Original v1/v2 files are retained. Both whole-session and per-message v2 formats are accepted. Existing IDs are preserved and their CLI IDs inferred only for legacy CLI sessions. Missing workspace metadata must be checked against CLI `init.cwd` before resuming. Mismatches create a current-workspace session and preserve the old transcript.

The pre-reconstruction backup contains installed 1.4.0, its VSIX, unfinished 1.4.1 sources, legacy history and settings. To roll back, reinstall that 1.4.0 VSIX through WSL; do not replace the user's complete settings file. New v3 records remain available for a later 2.0 installation; old versions continue using retained v2 data.

## Editor changes

File context includes full path, line range, document version and captured content. Generated code requires a diff preview. Apply checks the same document version and targets the previewed URI. A changed document requires a fresh preview. Markdown file links open files/lines; HTTP links use VS Code's external browser action.

In the unreleased optimization worktree, `ui/editorActions.ts` owns preview/application checks, preview tokens, diff content and document-close cleanup. Provider delegates these operations. Checks repeat after document/diff awaits; failed or invalidated creation releases its token/content. Disposal rejects late operations. `core/fileReference.ts` handles path parsing with injected roots/platform/URI conversion; explicit line suffixes are separated before URI decoding. `conversation/atomicFile.ts` shares complete-record publication and failure cleanup between migration and normal checkpoints; it preserves original errors and never deletes a colliding temporary record.

## Validation commands

```sh
npm ci
npm test
npm run test:performance
python3 scripts/benchmark-cli.py
npm run package
```

Windows development-host scripts require the supplied isolated test window with CDP port 9333 and Playwright on Windows. They exercise the actual VS Code Webview; headless browser tests are separately identified. Real OS IME probing is separately recorded and never inferred from synthetic composition events.

## 2.1 conversation coordination

ConversationCoordinator owns one ConversationController per materialized conversation. Each controller owns its CLI process, timers, generation, lease and transcript. Selection routes UI requests to one controller; background deltas never go to the Webview. A global delivery sequence is allocated only after routing, so filtering background messages does not trigger resynchronization loops. Background lifecycle changes are coalesced into a 30 ms session list update.

Plan and normal execution use separate CLI identities. The Plan agent has an explicit read-only tool allowlist, with no shell, file mutation, MCP or subagent tool. Approval binds to the last completed Plan message ID and submits its exact text to the normal execution identity. An old normal assistant response cannot be approved as a plan merely by switching the selector.

AgentRegistry handles native subagent_info and verified manage_subagents snapshots. It tracks no invented lifecycle or token values. It reads transcript pages only for explicit detail requests, validates local file URIs against the child's real CLI log directory, and subscribes to fs.watch only while the panel is visible. CLI control requests remain unsupported; native handoff is explicitly a fallback, not an in-Webview tool approval transport.


## 2.2 command dispatch

Commands use a shared registry and parser, then route through Provider to the existing Coordinator/Controller, verified native skill expansion, allowlisted CLI management or native terminals. Command results are transient and separate from model messages. Async discovery is checked against its originating session before changing configuration. Busy handoff is rejected, configuration is preserved, and public native transcript additions are imported with byte offsets. Schema validators are bundled with esbuild and initialized only on explicit Schema use. Protocol-limited features have a labelled terminal route; they are not model prompts.
