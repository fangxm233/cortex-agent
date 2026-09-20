Please update me when files in this folder change.

Remote worker daemon: connects to agent-server over WebSocket and runs
commands, file operations and streams on this machine.

| filename | role | function |
|---|---|---|
| client.ts | entry | Connect, handshake and dispatch server commands |
| auth-headers.ts | utility | Resolve the client token and build WS headers |
| command-exec.ts | core | Run bash commands, foreground and background |
| agents-md-scanner.ts | utility | Collect AGENTS.md chain for a read path |
| file-stream.ts | core | Stream file bytes back to the server |
| gpu-detect.ts | utility | Probe this machine's GPU count via nvidia-smi |
| log.ts | utility | Timestamped console logger |
| paths.ts | type | Client-side ~/.cortex path constants |
| reverse-stream.ts | core | Open reverse byte streams to the server |
| self-update.ts | core | Install a pushed bundle and re-exec |
| server-url.ts | utility | Resolve the server WebSocket URL |
